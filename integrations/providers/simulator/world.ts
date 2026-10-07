/**
 * The simulated provider world (TA §52): in-memory, deterministic state built from a scenario. Both simulator
 * ports read and change it; tests inspect it and drive "things that happen on the platform" (an audience
 * comment, a native brand reply, an edit, a native hide, a removal, a revoked credential).
 *
 * Determinism: time comes only from the scenario clock (`advanceClock`), new identities (including
 * authorization codes and issued credentials) from per-world counters, and faults from explicit rules.
 * `reset()` restores the scenario exactly and forgets every issued code. No network, no I/O, no randomness,
 * no wall clock.
 *
 * The simulator is a provider implementation, not the product's safety layer: it applies requested
 * mutations as a platform would and implements no product guard (mode, protection, permissions).
 */
import type { PlatformKey } from "../../../domain/platforms";
import type { ProviderCredential } from "../contract/credential";
import { providerCredential } from "../contract/credential";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TargetNotFoundError,
  TransientError,
  isProviderError,
  type AuthorizationOperation,
  type PermissionCapability,
  type ProviderError,
  type ProviderOperation,
} from "../contract/errors";
import { isoInstant, providerObjectRef, type IsoInstant, type ProviderObjectRef } from "../contract/identity";
import type { ProviderResult, RateBudgetSignal } from "../contract/pagination";
import { BUDGET_NOT_REPORTED } from "../contract/pagination";
import { FaultInjector, type FaultRule, type FaultSpec } from "./faults";
import type {
  ScenarioAsset,
  ScenarioAuthor,
  ScenarioContent,
  ScenarioCredential,
  ScenarioInteraction,
  SimulatedRestriction,
  SimulatorScenario,
} from "./scenario";

export interface InteractionState {
  readonly id: string;
  readonly content: string;
  readonly parent: string | null;
  readonly author: string;
  text: string;
  readonly createdAt: IsoInstant;
  editedAt: IsoInstant | null;
  revision: string | null;
  updatedAt: IsoInstant;
  visibility: "visible" | "hidden";
  presence: "present" | "removed_signaled" | "vanished";
  readonly restrictions: readonly SimulatedRestriction[];
}

export interface CredentialState {
  readonly id: string;
  secret: string;
  status: "active" | "revoked" | "expired";
  expiresAt: IsoInstant | null;
  readonly refresh: "supported" | "not_supported";
  readonly assets: readonly string[];
}

export interface AssetState extends ScenarioAsset {
  subscribed: boolean;
}

/** An authorization code the simulated authorization server issued (process-local, cleared by `reset()`). */
export interface AuthorizationCodeState {
  readonly grant: string;
  readonly redirectUri: string;
  readonly challenge: string | null;
  readonly expiresAtMs: number;
  consumed: boolean;
}

export interface PrivateReplyRecord {
  readonly receiptId: string;
  readonly account: string;
  readonly target: string;
  readonly at: IsoInstant;
  readonly textLength: number;
}

export const SIMULATED_EVENT_TYPES = [
  "interaction.created",
  "interaction.edited",
  "interaction.removed",
  "interaction.hidden",
  "interaction.unhidden",
  "content.created",
  "content.updated",
  "content.removed",
] as const;
export type SimulatedEventType = (typeof SIMULATED_EVENT_TYPES)[number];

/** A platform event the simulator would announce by webhook (identifiers only). */
export interface SimulatedEvent {
  readonly eventId: string;
  readonly type: SimulatedEventType;
  readonly platform: PlatformKey;
  readonly account: string;
  readonly target: { readonly kind: "content" | "interaction"; readonly id: string };
  readonly content: string | null;
  readonly occurredAt: IsoInstant;
  readonly sequence: string;
}

export interface JournalEntry {
  readonly seq: number;
  readonly at: IsoInstant;
  readonly operation: ProviderOperation;
  readonly targets: readonly string[];
  /** "ok", or the normalized error kind. */
  readonly outcome: string;
}

/** Simulated permission each operation needs, named by its normalized capability ("sim." prefix). */
const REQUIRED_CAPABILITY: Readonly<Record<ProviderOperation, PermissionCapability | null>> = {
  discoverAssets: null,
  describeAccount: "read_account",
  listContent: "read_content",
  listInteractions: "read_interactions",
  getInteraction: "read_interactions",
  getContent: "read_content",
  getCurrentState: "read_interactions",
  retrievePaidContext: "read_paid_context",
  parseWebhook: null,
  subscribe: "manage_webhooks",
  unsubscribe: "manage_webhooks",
  refreshCredential: null,
  replyPublicly: "reply_public",
  replyPrivately: "reply_private",
  hide: "hide",
  unhide: "hide",
  delete: "delete",
  block: "block",
  authorizationRequest: null,
  parseCallback: null,
  exchangeCode: null,
};

export const simulatedPermission = (capability: PermissionCapability): string => `sim.${capability}`;

export interface CallAuthorization {
  readonly credential: ProviderCredential;
  /** The account the call acts on (absent for credential-level calls). */
  readonly account?: string;
}

export class SimulatorWorld {
  readonly scenario: SimulatorScenario;
  readonly #faults = new FaultInjector();
  #now = 0;
  #seq = 0;
  #eventSeq = 0;
  #journal: JournalEntry[] = [];
  #events: SimulatedEvent[] = [];
  #privateReplies: PrivateReplyRecord[] = [];
  #credentials = new Map<string, CredentialState>();
  #assets = new Map<string, AssetState>();
  #authors = new Map<string, ScenarioAuthor>();
  #contents = new Map<string, ScenarioContent>();
  #interactions = new Map<string, InteractionState>();
  #blocks = new Set<string>();
  #budgetUse = new Map<string, number>();
  #authorizationCodes = new Map<string, AuthorizationCodeState>();

  constructor(scenario: SimulatorScenario) {
    this.scenario = scenario;
    this.reset();
  }

  /** Restores the scenario exactly: state, clock, counters, journal, events and faults. */
  reset(): void {
    const s = this.scenario;
    this.#now = Date.parse(s.clockStart);
    this.#seq = 0;
    this.#eventSeq = 0;
    this.#journal = [];
    this.#events = [];
    this.#privateReplies = [];
    this.#faults.clear();
    this.#credentials = new Map(s.credentials.map((c: ScenarioCredential) => [c.id, { ...c, assets: [...c.assets] }]));
    this.#assets = new Map(s.assets.map((a) => [a.id, { ...a, subscribed: a.subscribed }]));
    this.#authors = new Map(s.authors.map((a) => [a.id, a]));
    this.#contents = new Map(s.contents.map((c) => [c.id, c]));
    this.#interactions = new Map(s.interactions.map((i: ScenarioInteraction) => [i.id, { ...i, updatedAt: i.editedAt ?? i.createdAt }]));
    this.#blocks = new Set();
    this.#budgetUse = new Map();
    this.#authorizationCodes = new Map();
  }

  // ── Clock ────────────────────────────────────────────────────────────────────────────────────────────
  now(): IsoInstant {
    return isoInstant(new Date(this.#now));
  }

  advanceClock(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError("seconds must be >= 0");
    this.#now += seconds * 1000;
  }

  // ── Faults ───────────────────────────────────────────────────────────────────────────────────────────
  injectFaults(rules: readonly FaultRule[]): void {
    this.#faults.add(rules);
  }

  applyFaultPreset(name: string): void {
    const preset = this.scenario.faultPresets[name];
    if (preset === undefined) throw new TypeError("unknown fault preset");
    this.#faults.add(preset);
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  // ── Test accessors (synthetic credentials only) ──────────────────────────────────────────────────────
  credential(id: string): ProviderCredential {
    const state = this.#credentials.get(id);
    if (state === undefined) throw new TypeError("unknown credential");
    return providerCredential(state.id, state.secret);
  }

  assetRef(id: string): ProviderObjectRef<"asset"> {
    const asset = this.#assets.get(id);
    if (asset === undefined) throw new TypeError("unknown asset");
    return providerObjectRef(asset.platform, "asset", asset.id);
  }

  // ── Inspection ───────────────────────────────────────────────────────────────────────────────────────
  get journal(): readonly JournalEntry[] {
    return [...this.#journal];
  }

  get events(): readonly SimulatedEvent[] {
    return [...this.#events];
  }

  get privateReplies(): readonly PrivateReplyRecord[] {
    return [...this.#privateReplies];
  }

  interactionState(id: string): Readonly<InteractionState> | undefined {
    const state = this.#interactions.get(id);
    return state === undefined ? undefined : { ...state };
  }

  interactionCount(): number {
    return this.#interactions.size;
  }

  isBlocked(account: string, author: string): boolean {
    return this.#blocks.has(`${account}|${author}`);
  }

  isSubscribed(account: string): boolean {
    return this.#assets.get(account)?.subscribed ?? false;
  }

  // ── Things that happen on the platform (outside the product) ────────────────────────────────────────
  audienceComment(contentId: string, authorId: string, text: string): string {
    return this.#addInteraction(contentId, null, authorId, text);
  }

  audienceReply(parentId: string, authorId: string, text: string): string {
    const parent = this.#interactions.get(parentId) ?? this.#missing();
    return this.#addInteraction(parent.content, parentId, authorId, text);
  }

  /** The brand replies natively on the platform (not through the product). */
  nativeBrandReply(parentId: string, text: string): string {
    const parent = this.#interactions.get(parentId) ?? this.#missing();
    const account = this.#contentAccount(parent.content);
    if (account.identity === null) throw new TypeError("account has no identity");
    return this.#addInteraction(parent.content, parentId, account.identity, text);
  }

  editInteraction(id: string, text: string): void {
    const state = this.#interactions.get(id) ?? this.#missing();
    state.text = text;
    state.editedAt = this.now();
    state.updatedAt = state.editedAt;
    state.revision = `r${String(Number((state.revision ?? "r1").slice(1)) + 1)}`;
    this.#emit("interaction.edited", state);
  }

  nativeHide(id: string): void {
    this.setVisibility(id, "hidden");
  }

  nativeUnhide(id: string): void {
    this.setVisibility(id, "visible");
  }

  /** Removal on the platform. `signaled`: the provider says so (tombstone/event); otherwise it just vanishes. */
  removeAtSource(id: string, options: { readonly signaled: boolean }): void {
    const state = this.#interactions.get(id) ?? this.#missing();
    state.presence = options.signaled ? "removed_signaled" : "vanished";
    state.updatedAt = this.now();
    if (options.signaled) this.#emit("interaction.removed", state);
  }

  revokeCredential(id: string): void {
    (this.#credentials.get(id) ?? this.#missing()).status = "revoked";
  }

  expireCredential(id: string): void {
    (this.#credentials.get(id) ?? this.#missing()).status = "expired";
  }

  // ── Port internals ───────────────────────────────────────────────────────────────────────────────────
  /**
   * The lifecycle of one provider call: injected fault → credential → account access → simulated permission
   * → rate budget → effect. An `outcome_unknown` fault lets the effect happen and then loses the response.
   */
  execute<T>(operation: ProviderOperation, auth: CallAuthorization, targets: readonly string[], effect: () => T): ProviderResult<T> {
    const all = auth.account === undefined ? [...targets] : [auth.account, ...targets];
    try {
      const fault = this.#faults.next(operation, all);
      if (fault !== undefined && fault.kind !== "outcome_unknown") throw faultError(operation, fault);
      this.#checkCredential(operation, auth.credential);
      if (auth.account !== undefined) this.#checkAccount(operation, auth.credential, auth.account);
      const budget = this.#consumeBudget(operation, auth.account ?? `credential:${auth.credential.id}`);
      const data = effect();
      if (fault?.kind === "outcome_unknown") throw new OutcomeUnknownError(operation);
      this.#record(operation, all, "ok");
      return { data, budget };
    } catch (error) {
      this.#record(operation, all, isProviderError(error) ? error.kind : "error");
      throw error;
    }
  }

  /**
   * The lifecycle of an app-level authorization call (no credential, no account): injected fault → effect.
   * An `outcome_unknown` fault lets the effect happen (the code is redeemed) and then loses the response.
   * The simulated token endpoint reports no rate budget. Journal entries carry no code, verifier or state.
   */
  executeAuthorization<T>(operation: AuthorizationOperation, effect: () => T): ProviderResult<T> {
    try {
      const fault = this.#faults.next(operation, []);
      if (fault !== undefined && fault.kind !== "outcome_unknown") throw faultError(operation, fault);
      const data = effect();
      if (fault?.kind === "outcome_unknown") throw new OutcomeUnknownError(operation);
      this.#record(operation, [], "ok");
      return { data, budget: BUDGET_NOT_REPORTED };
    } catch (error) {
      this.#record(operation, [], isProviderError(error) ? error.kind : "error");
      throw error;
    }
  }

  /** Issues a deterministic, single-use authorization code. */
  issueAuthorizationCode(state: Omit<AuthorizationCodeState, "consumed">): string {
    this.#seq += 1;
    const code = `sim-code-${this.scenario.scenarioId}-${String(this.#seq)}`;
    this.#authorizationCodes.set(code, { ...state, consumed: false });
    return code;
  }

  authorizationCode(code: string): AuthorizationCodeState | undefined {
    return this.#authorizationCodes.get(code);
  }

  /** Issues a new active credential exposing `assets` (usable with the read port). */
  issueCredential(assets: readonly string[], expiresAt: IsoInstant | null): CredentialState {
    this.#seq += 1;
    const state: CredentialState = {
      id: `sim-cred-${String(this.#seq)}`,
      secret: `sim-access-token-${this.scenario.scenarioId}-${String(this.#seq)}`,
      status: "active",
      expiresAt,
      refresh: "supported",
      assets: [...assets],
    };
    this.#credentials.set(state.id, state);
    return state;
  }

  nowMs(): number {
    return this.#now;
  }

  recordWebhookParse(outcome: string): void {
    this.#record("parseWebhook", [], outcome);
  }

  credentialState(id: string): CredentialState | undefined {
    return this.#credentials.get(id);
  }

  asset(id: string): AssetState | undefined {
    return this.#assets.get(id);
  }

  assets(): readonly AssetState[] {
    return [...this.#assets.values()];
  }

  author(id: string): ScenarioAuthor | undefined {
    return this.#authors.get(id);
  }

  content(id: string): ScenarioContent | undefined {
    return this.#contents.get(id);
  }

  contents(): readonly ScenarioContent[] {
    return [...this.#contents.values()];
  }

  interaction(id: string): InteractionState | undefined {
    return this.#interactions.get(id);
  }

  interactions(): readonly InteractionState[] {
    return [...this.#interactions.values()];
  }

  /** A brand reply created through the mutation port. */
  createBrandReply(parentId: string, text: string): string {
    const parent = this.#interactions.get(parentId) ?? this.#missing();
    const account = this.#contentAccount(parent.content);
    if (account.identity === null) throw new TargetNotEligibleError("replyPublicly", "unsupported_for_target");
    return this.#addInteraction(parent.content, parentId, account.identity, text);
  }

  recordPrivateReply(account: string, target: string, textLength: number): PrivateReplyRecord {
    this.#seq += 1;
    const record: PrivateReplyRecord = { receiptId: `sim-pr-${String(this.#seq)}`, account, target, at: this.now(), textLength };
    this.#privateReplies.push(record);
    return record;
  }

  setVisibility(id: string, visibility: "visible" | "hidden"): boolean {
    const state = this.#interactions.get(id) ?? this.#missing();
    if (state.visibility === visibility) return false;
    state.visibility = visibility;
    state.updatedAt = this.now();
    this.#emit(visibility === "hidden" ? "interaction.hidden" : "interaction.unhidden", state);
    return true;
  }

  setBlocked(account: string, author: string): boolean {
    const key = `${account}|${author}`;
    if (this.#blocks.has(key)) return false;
    this.#blocks.add(key);
    return true;
  }

  setSubscribed(account: string, subscribed: boolean): boolean {
    const asset = this.#assets.get(account) ?? this.#missing();
    if (asset.subscribed === subscribed) return false;
    asset.subscribed = subscribed;
    return true;
  }

  rotateCredentialSecret(id: string, expiresAt: IsoInstant): CredentialState {
    const state = this.#credentials.get(id) ?? this.#missing();
    this.#seq += 1;
    state.secret = `${state.secret.split("#")[0] ?? state.secret}#refreshed-${String(this.#seq)}`;
    state.expiresAt = expiresAt;
    return state;
  }

  // ── Private ──────────────────────────────────────────────────────────────────────────────────────────
  #addInteraction(contentId: string, parent: string | null, author: string, text: string): string {
    const content = this.#contents.get(contentId) ?? this.#missing();
    const platform = this.#contentAccount(content.id).platform;
    this.#seq += 1;
    const id = `sim-${platform}-int-${String(this.#seq)}`;
    const at = this.now();
    const state: InteractionState = {
      id, content: contentId, parent, author, text, createdAt: at, editedAt: null, revision: "r1", updatedAt: at,
      visibility: "visible", presence: "present", restrictions: [],
    };
    this.#interactions.set(id, state);
    this.#emit("interaction.created", state);
    return id;
  }

  #contentAccount(contentId: string): AssetState {
    const content = this.#contents.get(contentId) ?? this.#missing();
    return this.#assets.get(content.account) ?? this.#missing();
  }

  #emit(type: SimulatedEventType, interaction: InteractionState): void {
    const account = this.#contentAccount(interaction.content);
    this.#eventSeq += 1;
    this.#events.push({
      eventId: `sim-evt-${String(this.#eventSeq)}`,
      type,
      platform: account.platform,
      account: account.id,
      target: { kind: "interaction", id: interaction.id },
      content: interaction.content,
      occurredAt: this.now(),
      sequence: String(this.#eventSeq),
    });
  }

  #checkCredential(operation: ProviderOperation, credential: ProviderCredential): void {
    const state = this.#credentials.get(credential.id);
    if (state === undefined || state.secret !== credential.secret.expose()) throw new CredentialInvalidError(operation, "malformed");
    if (state.status === "revoked") throw new CredentialInvalidError(operation, "revoked");
    if (state.status === "expired" || (state.expiresAt !== null && Date.parse(state.expiresAt) <= this.#now)) {
      throw new CredentialInvalidError(operation, "expired");
    }
  }

  #checkAccount(operation: ProviderOperation, credential: ProviderCredential, accountId: string): void {
    const state = this.#credentials.get(credential.id);
    const asset = this.#assets.get(accountId);
    // An account the credential doesn't expose looks exactly like one that doesn't exist.
    if (state === undefined || asset === undefined || !state.assets.includes(accountId)) throw new TargetNotFoundError(operation);
    const capability = REQUIRED_CAPABILITY[operation];
    if (capability !== null && !asset.permissions.includes(simulatedPermission(capability))) throw new PermissionMissingError(operation, capability);
  }

  #consumeBudget(operation: ProviderOperation, key: string): RateBudgetSignal {
    const budget = this.scenario.rateBudget;
    if (budget.mode === "not_reported") return BUDGET_NOT_REPORTED;
    const windowMs = budget.windowSeconds * 1000;
    const start = Date.parse(this.scenario.clockStart);
    const window = Math.floor((this.#now - start) / windowMs);
    const resetMs = start + (window + 1) * windowMs;
    const useKey = `${key}|${String(window)}`;
    const used = (this.#budgetUse.get(useKey) ?? 0) + 1;
    if (used > budget.limit) throw new RateLimitedError(operation, Math.ceil((resetMs - this.#now) / 1000));
    this.#budgetUse.set(useKey, used);
    return {
      kind: "reported",
      scope: "account",
      usedRatio: Math.round((used / budget.limit) * 10_000) / 10_000,
      remainingCalls: budget.limit - used,
      resetAt: isoInstant(new Date(resetMs)),
    };
  }

  #record(operation: ProviderOperation, targets: readonly string[], outcome: string): void {
    this.#journal.push({ seq: this.#journal.length + 1, at: this.now(), operation, targets: [...targets], outcome });
  }

  #missing(): never {
    throw new TypeError("unknown simulated object");
  }
}

/** Runs a synchronous simulated call so that every failure surfaces as a rejected promise, never a throw. */
export function asPromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("simulator_failure"));
  }
}

/** Converts an injected fault into the normalized contract error. */
export function faultError(operation: ProviderOperation, fault: FaultSpec): ProviderError {
  switch (fault.kind) {
    case "rate_limited":
      return new RateLimitedError(operation, fault.retryAfterSeconds);
    case "transient":
      return new TransientError(operation, fault.reason);
    case "permission_missing":
      return new PermissionMissingError(operation, fault.capability);
    case "credential_invalid":
      return new CredentialInvalidError(operation, fault.reason);
    case "target_not_found":
      return new TargetNotFoundError(operation);
    case "target_not_eligible":
      return new TargetNotEligibleError(operation, fault.reason);
    case "permanent_rejected":
      return new PermanentRejectedError(operation, fault.reasonCode);
    case "timeout_before_send":
      return new TransientError(operation, "timeout_before_send");
    case "outcome_unknown":
      return new OutcomeUnknownError(operation);
  }
}
