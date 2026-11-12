/**
 * Step 7B-14G1 — the one-time validation authorization integrated into the ONE request and executor path, offline:
 *
 *   decision   decideValidationAdmission is fail-closed: absent / another workspace, organization, account, target,
 *              initiator, operation or platform / revoked / expired (database verdict) / consumed / bound elsewhere /
 *              target already validated / a non-first attempt all refuse; a pause or the emergency block always
 *              vetoes; only a catalog that has not validated reply_public may be stood in for (never NOT_AUTHORIZED,
 *              UNSUPPORTED, stale, …); a missing grant may be stood in for
 *   request    an ordinary request is unchanged (no grant → PROVIDER_ACTIONS_DISABLED; UNKNOWN → CAPABILITY_UNAVAILABLE);
 *              with an admitting authorization the intent is created naming it; every refusal writes nothing and names
 *              ONE closed reason; the key's payload includes the authorization
 *   executor   admitted → EXECUTING → exactly ONE call → CONFIRMED; every refusal is BLOCKED from PENDING with ZERO
 *              calls and no credential; F: a revocation or expiry that lands between the check and the EXECUTING commit
 *              ends BLOCKED in a new transaction (never a fictitious revocation for an infrastructure failure);
 *              X2: a second consumption refused for the target ends BLOCKED; PRE-LIVE-1: a pause or a mode change after
 *              EXECUTING ends BLOCKED before the credential opens; X1: a rewritten row is never sent; OUTCOME_UNKNOWN and
 *              a redelivered run never send again; PRE-LIVE-2: an unauthorizable credential blocks before spending
 *
 * Synthetic data only; the provider is the REAL Meta port on the REAL write transport with a FAKE fetch (never the network).
 */
import { describe, expect, it } from "vitest";
import { CredentialInvalidError } from "@/integrations/providers/contract/errors";
import { providerCredential } from "@/integrations/providers/contract/credential";
import { providerObjectRef } from "@/integrations/providers/contract/identity";
import { createMetaGraphWriteTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaMutationPort } from "@/integrations/providers/meta/mutation-port";
import {
  VALIDATION_AUTHORIZATION_OPERATION,
  decideFinalSend,
  decideValidationAdmission,
  examinedCredentialRefusal,
  type FinalSendInput,
  validationNoLongerAdmits,
  type ValidationAdmissionInput,
  type ValidationAuthorization,
  type ValidationAuthorizationReading,
  type ValidationPreflightBinding,
} from "@/mutations/domain/validation-authorization";
import { CredentialUnreadable, ROLES_WITH_PUBLIC_REPLY, executeIntent, type ExecutorDependencies, type ExecutorStores } from "@/mutations/executor/execute";
import type { CredentialUse, OutboundReply, ProviderActionDecision, ValidationExecutionReads } from "@/mutations/ports";
import { requestPublicReply, type PublicReplyRequest } from "@/mutations/request";
import { ACCOUNT, CORRELATION, ORGANIZATION, OTHER_WORKSPACE, TARGET, USER, WORKSPACE, fixedClock, guardState, memoryStores, pendingIntent, replyTarget, statusesOf, type MemoryStores } from "./support";

const AUTHORIZATION = "c1c2c3c4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER = "d1d2d3d4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const IG_ASSET = "17841400000000001";
const IG_COMMENT = "17900000000000001";
const IG_REPLY = "17900000000000099";
const RUN = "run_7b14g1_0001";
const TEXT = "Gracias por escribirnos (7B-14G1).";
const now = new Date("2026-11-11T12:00:00.000Z");

function authorization(overrides: Partial<ValidationAuthorization> = {}): ValidationAuthorization {
  return {
    id: AUTHORIZATION,
    organizationId: ORGANIZATION,
    workspaceId: WORKSPACE,
    connectedAccountId: ACCOUNT,
    targetInteractionId: TARGET,
    initiatorUserId: USER,
    ...VALIDATION_AUTHORIZATION_OPERATION,
    preflightRunReference: "run_preflight_synthetic",
    preflightCompletedAt: new Date(now.getTime() - 5 * 60_000),
    issuedBy: "ops.synthetic",
    issueReason: "test",
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    intentId: null,
    boundAt: null,
    consumedAt: null,
    ...overrides,
  };
}
const reading = (overrides: Partial<ValidationAuthorization> = {}, expired = false): ValidationAuthorizationReading => ({ authorization: authorization(overrides), expired });

// ── 1 · the pure decision ───────────────────────────────────────────────────────────────────────────────────────
describe("7B-14G1: decideValidationAdmission is the one, fail-closed place", () => {
  const requestInput = (overrides: Partial<ValidationAdmissionInput> = {}): ValidationAdmissionInput => ({
    phase: "request",
    subject: { intentId: null, organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectedAccountId: ACCOUNT, targetInteractionId: TARGET, initiatorUserId: USER, kind: "reply_public", attempt: 0 },
    reading: reading(),
    account: { provider: "meta", platform: "instagram" },
    targetPlatform: "instagram",
    providerAction: "not_enabled",
    capability: { usable: false, catalogValidationPending: true },
    consumedElsewhere: false,
    ...overrides,
  });
  const executionInput = (overrides: Partial<ValidationAdmissionInput> = {}): ValidationAdmissionInput =>
    requestInput({ phase: "execution", subject: { ...requestInput().subject, intentId: "i-1" }, reading: reading({ intentId: "i-1", boundAt: now }), ...overrides });
  const decide = (input: ValidationAdmissionInput) => decideValidationAdmission(input);

  it("admits exactly the authorized scope, standing in for a missing grant and an unvalidated catalog (request and execution)", () => {
    expect(decide(requestInput())).toEqual({ kind: "admit" });
    expect(decide(executionInput())).toEqual({ kind: "admit" });
    // An existing exact grant and a usable capability need no substitution — the authorization must still be valid.
    expect(decide(requestInput({ providerAction: "allowed", capability: { usable: true, catalogValidationPending: false } }))).toEqual({ kind: "admit" });
  });

  it.each([
    ["absent / invisible (RLS) / another workspace's", { reading: undefined }],
    ["another workspace", { reading: reading({ workspaceId: OTHER_WORKSPACE }) }],
    ["another organization", { reading: reading({ organizationId: OTHER }) }],
    ["another account", { reading: reading({ connectedAccountId: OTHER }) }],
    ["another comment", { reading: reading({ targetInteractionId: OTHER }) }],
    ["another initiator", { reading: reading({ initiatorUserId: OTHER }) }],
    ["expired (database verdict)", { reading: reading({}, true) }],
    ["revoked", { reading: reading({ revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" }) }],
    ["consumed", { reading: reading({ intentId: "i-0", boundAt: now, consumedAt: now }) }],
    ["already bound to another intent", { reading: reading({ intentId: "i-0", boundAt: now }) }],
    ["a target already validated by another authorization", { consumedElsewhere: true }],
    ["a Facebook account", { account: { provider: "meta", platform: "facebook" } }],
    ["a simulator account", { account: { provider: "simulator", platform: "instagram" } }],
    ["a Facebook target", { targetPlatform: "facebook" }],
    ["another operation on the authorization", { reading: { authorization: { ...authorization(), kind: "hide" as never }, expired: false } }],
    ["another platform on the authorization", { reading: { authorization: { ...authorization(), platform: "facebook" as never }, expired: false } }],
  ] as const)("refuses the authorization (request): %s", (_name, overrides) => {
    expect(decide(requestInput(overrides as Partial<ValidationAdmissionInput>))).toEqual({ kind: "refuse", reason: "authorization" });
  });

  it("refuses another operation on the intent, and at execution anything but THIS bound, never-attempted intent", () => {
    expect(decide(requestInput({ subject: { ...requestInput().subject, kind: "hide" } }))).toEqual({ kind: "refuse", reason: "authorization" });
    expect(decide(executionInput({ reading: reading({ intentId: "i-other", boundAt: now }) }))).toEqual({ kind: "refuse", reason: "authorization" });
    expect(decide(executionInput({ reading: reading() }))).toEqual({ kind: "refuse", reason: "authorization" });
    expect(decide(executionInput({ subject: { ...executionInput().subject, attempt: 1 } }))).toEqual({ kind: "refuse", reason: "authorization" });
    // At request time an intent id is never present.
    expect(decide(requestInput({ subject: { ...requestInput().subject, intentId: "i-1" } }))).toEqual({ kind: "refuse", reason: "authorization" });
  });

  it("a pause or the emergency block ALWAYS vetoes, even with a valid authorization and an exact grant elsewhere", () => {
    expect(decide(requestInput({ providerAction: "paused" }))).toEqual({ kind: "refuse", reason: "provider_action" });
    expect(decide(executionInput({ providerAction: "paused" }))).toEqual({ kind: "refuse", reason: "provider_action" });
  });

  it("only an unvalidated catalog is stood in for: any other unusable capability refuses", () => {
    expect(decide(requestInput({ capability: { usable: false, catalogValidationPending: false } }))).toEqual({ kind: "refuse", reason: "capability" });
    expect(decide(executionInput({ capability: { usable: false, catalogValidationPending: false } }))).toEqual({ kind: "refuse", reason: "capability" });
  });

  it("validationNoLongerAdmits decides the recovery on data only", () => {
    expect(validationNoLongerAdmits(reading({ intentId: "i-1", boundAt: now }), "i-1", false)).toBe(false);
    expect(validationNoLongerAdmits(undefined, "i-1", false)).toBe(true);
    expect(validationNoLongerAdmits(reading({ intentId: "i-1", boundAt: now, revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" }), "i-1", false)).toBe(true);
    expect(validationNoLongerAdmits(reading({ intentId: "i-1", boundAt: now }, true), "i-1", false)).toBe(true);
    expect(validationNoLongerAdmits(reading({ intentId: "i-1", boundAt: now, consumedAt: now }), "i-1", false)).toBe(true);
    expect(validationNoLongerAdmits(reading({ intentId: "i-2", boundAt: now }), "i-1", false)).toBe(true);
    expect(validationNoLongerAdmits(reading({ intentId: "i-1", boundAt: now }), "i-1", true)).toBe(true);
  });
});

// ── harness: Instagram account, validation reads, the Meta port on a fake fetch ────────────────────────────────────
interface ValidationState {
  reading: ValidationAuthorizationReading | undefined;
  pending: boolean;
  consumedElsewhere: boolean;
  credentialReady: boolean;
  /** The account's authorized credential id NOW (null: none is); the fake opener opens "cred-1". */
  activeCredential: string | null;
  /** Step 7B-14I3H (H1): the connection whose active credential that is. */
  activeConnection: string;
  /**
   * Step 7B-14I3H (H1): the PREFLIGHT evidence linked to the authorization. "auto": the authorization's own evidence,
   * which examined cred-1 on conn-1 (what issuance through 0029 persists); null: none is linked; a function: derived.
   */
  examined: "auto" | null | ((authorization: ValidationAuthorization) => ValidationPreflightBinding);
  providerAction: ProviderActionDecision[];
}

/** The evidence 0029 links to an authorization: its account, target, run reference and recording instant; cred-1 on conn-1. */
const evidenceOf = (a: ValidationAuthorization, overrides: Partial<ValidationPreflightBinding> = {}): ValidationPreflightBinding => ({
  preflightId: "d0d1d2d3-0000-4000-8000-000000000001", authorizationId: a.id, workspaceId: a.workspaceId, connectedAccountId: a.connectedAccountId, targetInteractionId: a.targetInteractionId,
  connectionId: "conn-1", credentialId: "cred-1", runReference: a.preflightRunReference, recordedAt: a.preflightCompletedAt, passed: true, ...overrides,
});

function igStores(state: Partial<ValidationState> = {}, options: { readonly withValidation?: boolean; readonly capability?: "AVAILABLE" | "UNAVAILABLE" } = {}) {
  const v: ValidationState = { reading: undefined, pending: true, consumedElsewhere: false, credentialReady: true, activeCredential: "cred-1", activeConnection: "conn-1", examined: "auto", providerAction: ["not_enabled"], ...state };
  const stores: MemoryStores = memoryStores(
    guardState({ capability: options.capability ?? "UNAVAILABLE", account: { status: "ACTIVE", platform: "instagram", provider: "meta", providerAssetId: IG_ASSET, connectionStatus: "ACTIVE", credentialId: "cred-1" } }),
    [replyTarget({ platform: "instagram", providerInteractionId: IG_COMMENT, providerAssetId: IG_ASSET, kind: "comment", parentProviderInteractionId: null })],
  );
  // The exact provider-action decisions, in order (the last one repeats): "not_enabled" is today's DEV state.
  let switchReads = 0;
  const guards = { ...stores.guards, providerActionAllowed: (platform: string, action: string) => {
    stores.calls.push(`switch:${platform}:${action}`);
    return Promise.resolve(v.providerAction[Math.min(switchReads++, v.providerAction.length - 1)] ?? "paused");
  } };
  const validation: ValidationExecutionReads = {
    authorization: (workspaceId, id) => {
      stores.calls.push("validation:read");
      const current = v.reading;
      if (current === undefined || current.authorization.workspaceId !== workspaceId || current.authorization.id !== id) return Promise.resolve(undefined);
      // As 0028's consume trigger does: the transition of its bound intent into EXECUTING spends it (write-once).
      const bound = current.authorization.intentId;
      const consumed = bound !== null && stores.history.some((h) => h.intentId === bound && h.to === "EXECUTING");
      return Promise.resolve(consumed && current.authorization.consumedAt === null ? { ...current, authorization: { ...current.authorization, consumedAt: now } } : current);
    },
    catalogValidationPending: () => Promise.resolve(v.pending),
    consumedElsewhere: () => Promise.resolve(v.consumedElsewhere),
    credentialReady: () => {
      stores.calls.push("validation:credential_ready");
      return Promise.resolve(v.credentialReady);
    },
    activeCredential: () => {
      stores.calls.push("validation:active_credential");
      return Promise.resolve(v.activeCredential === null ? undefined : { credentialId: v.activeCredential, connectionId: v.activeConnection, platform: "instagram", providerAssetId: IG_ASSET });
    },
    examinedCredential: (workspaceId, authorizationId) => {
      stores.calls.push("validation:examined");
      const current = v.reading?.authorization;
      if (v.examined === null || current === undefined || current.workspaceId !== workspaceId || current.id !== authorizationId) return Promise.resolve(undefined);
      return Promise.resolve(v.examined === "auto" ? evidenceOf(current) : v.examined(current));
    },
  };
  const composed: MemoryStores & ExecutorStores = Object.assign(stores, { guards, ...(options.withValidation === false ? {} : { validation }) });
  return { stores: composed, v };
}

function metaHarness(answer: "created" | "lost" | { readonly status: number; readonly body: unknown } = "created") {
  const posts: string[] = [];
  const fetch: MetaGraphFetch = (url) => {
    posts.push(new URL(url).pathname);
    if (answer === "lost") return Promise.reject(new Error("socket hang up"));
    const response = answer === "created" ? { status: 200, body: { id: IG_REPLY } } : answer;
    return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } }));
  };
  const port = createMetaMutationPort({ transport: createMetaGraphWriteTransport({ fetch, timeoutMs: 100 }) });
  return { posts, port };
}

function seed(stores: MemoryStores, overrides: Parameters<typeof pendingIntent>[1] = {}) {
  const clock = fixedClock();
  const intent = pendingIntent(clock, { validationAuthorizationId: AUTHORIZATION, capabilityCatalogId: "platform", capabilityCatalogRevision: 5, ...overrides });
  stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
  const reply: OutboundReply = { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, intentId: intent.id, parentInteractionId: TARGET, connectedAccountId: ACCOUNT, platform: "instagram", text: TEXT, providerReplyId: null, confirmedAt: null, createdAt: clock.now() };
  stores.replyRows.set(`${WORKSPACE}:${intent.id}`, reply);
  stores.history.push({ intentId: intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null });
  return { intent, clock };
}

function deps(stores: ExecutorStores & MemoryStores, clock: ReturnType<typeof fixedClock>, port: ReturnType<typeof metaHarness>["port"], options: { readonly opened?: string[]; readonly credentials?: CredentialUse; readonly inScope?: ExecutorDependencies["inScope"] } = {}): ExecutorDependencies {
  const opened = options.opened ?? [];
  return {
    inScope: options.inScope ?? ((work) => work(stores)),
    credentials: options.credentials ?? {
      withAccess: (input, use) => {
        opened.push(input.connectedAccountId);
        stores.calls.push("credential:open");
        return use({ credential: providerCredential("cred-synthetic", "synthetic-user-token"), account: providerObjectRef("instagram", "asset", IG_ASSET) }, { credentialId: "cred-1" });
      },
    },
    providers: { mutation: (provider, platform) => (provider === "meta" && platform === "instagram" ? port : undefined) },
    clock,
  };
}

const intentOf = (stores: MemoryStores, id: string) => stores.intentRows.get(`${WORKSPACE}:${id}`);

// ── 2 · the request side ────────────────────────────────────────────────────────────────────────────────────────
describe("7B-14G1: the request side", () => {
  const context = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION };
  const request = (overrides: Partial<PublicReplyRequest> = {}): PublicReplyRequest => ({ targetInteractionId: TARGET, text: TEXT, idempotencyKey: "form-render-14g1-0001", ...overrides });
  const nothingWritten = (stores: MemoryStores): void => {
    expect([stores.intentRows.size, stores.replyRows.size, stores.history.length]).toEqual([0, 0, 0]);
  };

  it("(1, 24) an ordinary request is unchanged: no grant → PROVIDER_ACTIONS_DISABLED, and the validation reads are never consulted", async () => {
    const { stores } = igStores({ reading: reading() });
    expect(await requestPublicReply(stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
    expect(stores.calls).not.toContain("validation:read");
    nothingWritten(stores);
    // With an exact grant, the unvalidated catalog still refuses an ordinary request.
    const granted = igStores({ reading: reading(), providerAction: ["allowed"] });
    expect(await requestPublicReply(granted.stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    nothingWritten(granted.stores);
  });

  it("(13) an admitting authorization creates the PENDING intent naming it, with the stored catalog it relied on", async () => {
    const { stores } = igStores({ reading: reading() });
    const outcome = await requestPublicReply(stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }));
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.intent).toMatchObject({ status: "PENDING", attempt: 0, validationAuthorizationId: AUTHORIZATION, initiatorUserId: USER, targetInteractionId: TARGET, connectedAccountId: ACCOUNT });
    expect(stores.history).toHaveLength(1);
  });

  it.each([
    ["(2) a non-existent id", { reading: undefined }],
    ["(3) another workspace's", { reading: reading({ workspaceId: OTHER_WORKSPACE }) }],
    ["(4) another account's", { reading: reading({ connectedAccountId: OTHER }) }],
    ["(5) another comment's", { reading: reading({ targetInteractionId: OTHER }) }],
    ["(6) another initiator's", { reading: reading({ initiatorUserId: OTHER }) }],
    ["(7) an expired", { reading: reading({}, true) }],
    ["(8) a revoked", { reading: reading({ revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" }) }],
    ["(9) a consumed", { reading: reading({ intentId: OTHER, boundAt: now, consumedAt: now }) }],
    ["(10) an already bound", { reading: reading({ intentId: OTHER, boundAt: now }) }],
  ] as const)("%s authorization is refused with ONE closed reason; nothing is written", async (_name, state) => {
    const { stores } = igStores(state);
    expect(await requestPublicReply(stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    nothingWritten(stores);
  });

  it("(11) a nested Instagram reply or an own message is refused BEFORE the authorization is even read", async () => {
    const { stores } = igStores({ reading: reading() });
    stores.targetRows.set(TARGET, replyTarget({ platform: "instagram", kind: "reply", parentProviderInteractionId: IG_COMMENT }));
    expect(await requestPublicReply(stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "TARGET_NOT_REPLYABLE" });
    stores.targetRows.set(TARGET, replyTarget({ platform: "instagram", ownAccount: true }));
    expect(await requestPublicReply(stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "TARGET_OWN_ACCOUNT" });
    expect(stores.calls).not.toContain("validation:read");
    nothingWritten(stores);
  });

  it("(12, 22) a Facebook account is refused; a pause vetoes; any capability state but an unvalidated catalog refuses; no validation reads → refused", async () => {
    const facebook = igStores({ reading: reading() });
    facebook.stores.guardState.account = { status: "ACTIVE", platform: "facebook", provider: "meta", providerAssetId: "fb_1", connectionStatus: "ACTIVE", credentialId: "cred-1" };
    facebook.stores.targetRows.set(TARGET, replyTarget({ platform: "facebook" }));
    expect(await requestPublicReply(facebook.stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    const paused = igStores({ reading: reading(), providerAction: ["paused"] });
    expect(await requestPublicReply(paused.stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
    const notAuthorized = igStores({ reading: reading(), pending: false });
    expect(await requestPublicReply(notAuthorized.stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    const unwired = igStores({ reading: reading() }, { withValidation: false });
    expect(await requestPublicReply(unwired.stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    for (const s of [facebook, paused, notAuthorized, unwired]) nothingWritten(s.stores);
  });

  it("the idempotency key's payload includes the authorization: same → existing; with vs without → key reuse", async () => {
    const { stores } = igStores({ reading: reading() });
    const clock = fixedClock();
    expect((await requestPublicReply(stores, clock, context, request({ validationAuthorizationId: AUTHORIZATION }))).kind).toBe("created");
    expect((await requestPublicReply(stores, clock, context, request({ validationAuthorizationId: AUTHORIZATION }))).kind).toBe("existing");
    expect(await requestPublicReply(stores, clock, context, request())).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(stores.intentRows.size).toBe(1);
  });
});

// ── 3 · the executor ────────────────────────────────────────────────────────────────────────────────────────────
describe("7B-14G1: the executor honours a bound authorization only within its bounds", () => {
  const bound = (intentId: string, overrides: Partial<ValidationAuthorization> = {}, expired = false) => reading({ intentId, boundAt: now, ...overrides }, expired);

  it("(13) admitted → EXECUTING before the ONE Meta POST → CONFIRMED with the created reply's id; no grant and an UNKNOWN catalog stood in for", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "confirmed", providerReplyId: IG_REPLY });
    expect(meta.posts).toEqual([`/v25.0/${IG_COMMENT}/replies`]);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    // The credential is checked (read only) before EXECUTING, opened only after it, once.
    const calls = stores.calls.filter((c) => c === "validation:credential_ready" || c === "transition:EXECUTING" || c === "credential:open");
    expect(calls).toEqual(["validation:credential_ready", "transition:EXECUTING", "credential:open"]);
  });

  it.each([
    ["(2) gone or invisible", undefined],
    ["(7) expired (database verdict)", "expired"],
    ["(8) revoked", "revoked"],
    ["(9) consumed", "consumed"],
    ["(10) bound to another intent", "elsewhere"],
    ["(6) another initiator", "initiator"],
    ["(4) another account", "account"],
  ] as const)("%s → BLOCKED VALIDATION_AUTHORIZATION_UNAVAILABLE from PENDING: zero POSTs, no credential", async (_name, variant) => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = variant === undefined ? undefined
      : variant === "expired" ? bound(intent.id, {}, true)
        : variant === "revoked" ? bound(intent.id, { revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" })
          : variant === "consumed" ? bound(intent.id, { consumedAt: now })
            : variant === "elsewhere" ? bound(OTHER)
              : variant === "initiator" ? bound(intent.id, { initiatorUserId: OTHER })
                : bound(intent.id, { connectedAccountId: OTHER });
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await executeIntent(deps(stores, clock, meta.port, { opened }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "BLOCKED", attempt: 1, outcomeCode: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect([meta.posts, opened]).toEqual([[], []]);
    expect(statusesOf(stores)).toEqual(["PENDING", "BLOCKED"]);
  });

  it("(21, X2) a target already validated by another consumed authorization → BLOCKED, never eligible again", async () => {
    const { stores, v } = igStores({ consumedElsewhere: true });
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_again" })).toEqual({ kind: "noop", status: "BLOCKED" });
    expect(meta.posts).toEqual([]);
  });

  it("(22) a pause / the emergency block vetoes; (12) a non-validation capability state refuses; an unwired executor blocks", async () => {
    for (const [state, options, code] of [
      [{ providerAction: ["paused"] as ProviderActionDecision[] }, {}, "PROVIDER_ACTIONS_DISABLED"],
      [{ pending: false }, {}, "CAPABILITY_UNAVAILABLE"],
      [{}, { withValidation: false }, "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ] as const) {
      const { stores, v } = igStores(state, options);
      const { intent, clock } = seed(stores);
      v.reading = bound(intent.id);
      const meta = metaHarness();
      expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code });
      expect(meta.posts).toEqual([]);
    }
  });

  it("an ordinary intent is unchanged: no grant → PROVIDER_ACTIONS_DISABLED, and the validation reads are never consulted", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores, { validationAuthorizationId: null });
    v.reading = bound(intent.id);
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(stores.calls.filter((c) => c.startsWith("validation:"))).toEqual([]);
    expect(meta.posts).toEqual([]);
  });

  it("(23, PRE-LIVE-2) an unauthorizable credential blocks BEFORE EXECUTING (nothing spent); a credential failure after EXECUTING never grants another try", async () => {
    const before = igStores({ credentialReady: false });
    const first = seed(before.stores);
    before.v.reading = bound(first.intent.id);
    const meta = metaHarness();
    expect(await executeIntent(deps(before.stores, first.clock, meta.port), { workspaceId: WORKSPACE, intentId: first.intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect(statusesOf(before.stores)).toEqual(["PENDING", "BLOCKED"]);

    const after = igStores();
    const second = seed(after.stores);
    after.v.reading = bound(second.intent.id);
    const credentials: CredentialUse = { withAccess: () => Promise.reject(new CredentialUnreadable()) };
    expect(await executeIntent(deps(after.stores, second.clock, meta.port, { credentials }), { workspaceId: WORKSPACE, intentId: second.intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect(statusesOf(after.stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
    // Consumed at EXECUTING (the database's), never re-armed: the next delivery does nothing.
    after.v.reading = bound(second.intent.id, { consumedAt: now });
    expect(await executeIntent(deps(after.stores, second.clock, meta.port), { workspaceId: WORKSPACE, intentId: second.intent.id, runReference: "run_again" })).toEqual({ kind: "noop", status: "BLOCKED" });
    // A credential the provider rejects (after the call) is FAILED — still one call, never a retry.
    const rejected = igStores();
    const third = seed(rejected.stores);
    rejected.v.reading = bound(third.intent.id);
    const credentialRejected: CredentialUse = { withAccess: () => Promise.reject(new CredentialInvalidError("replyPublicly", "revoked")) };
    expect(await executeIntent(deps(rejected.stores, third.clock, meta.port, { credentials: credentialRejected }), { workspaceId: WORKSPACE, intentId: third.intent.id, runReference: RUN })).toEqual({ kind: "failed", code: "CREDENTIAL_INVALID" });
    expect(meta.posts).toEqual([]);
  });

  it("(16, F) a revocation landing between the check and the EXECUTING commit (the consume trigger refuses) → BLOCKED in a new transaction, zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const transition = stores.intents.transition.bind(stores.intents);
    stores.intents.transition = (workspaceId, id, next) => {
      if (next.status === "EXECUTING") {
        v.reading = bound(intent.id, { revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" });
        return Promise.reject(new Error("the validation authorization is revoked"));
      }
      return transition(workspaceId, id, next);
    };
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await executeIntent(deps(stores, clock, meta.port, { opened }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "BLOCKED", attempt: 1 });
    expect(statusesOf(stores)).toEqual(["PENDING", "BLOCKED"]);
    expect([meta.posts, opened]).toEqual([[], []]);
  });

  it("(17, F) an expiry crossing between the check and the EXECUTING commit → BLOCKED, zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const transition = stores.intents.transition.bind(stores.intents);
    stores.intents.transition = (workspaceId, id, next) => {
      if (next.status === "EXECUTING") {
        v.reading = bound(intent.id, {}, true);
        return Promise.reject(new Error("the validation authorization is expired"));
      }
      return transition(workspaceId, id, next);
    };
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(meta.posts).toEqual([]);
  });

  it("(21, X2) a second consumption refused by the unique index (another authorization consumed meanwhile) → BLOCKED, never left PENDING", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const transition = stores.intents.transition.bind(stores.intents);
    stores.intents.transition = (workspaceId, id, next) => {
      if (next.status === "EXECUTING") {
        v.consumedElsewhere = true;
        return Promise.reject(new Error("duplicate key value violates unique constraint"));
      }
      return transition(workspaceId, id, next);
    };
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(intentOf(stores, intent.id)?.status).toBe("BLOCKED");
    expect(meta.posts).toEqual([]);
  });

  it("an infrastructure failure at the EXECUTING commit is NEVER recorded as a revocation: the original error, the intent still PENDING, zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const transition = stores.intents.transition.bind(stores.intents);
    const failure = new Error("connection terminated unexpectedly");
    stores.intents.transition = (workspaceId, id, next) => (next.status === "EXECUTING" ? Promise.reject(failure) : transition(workspaceId, id, next));
    const meta = metaHarness();
    await expect(executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).rejects.toBe(failure);
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "PENDING", attempt: 0, outcomeCode: null });
    expect(meta.posts).toEqual([]);
    // The recovery transaction itself failing re-throws the ORIGINAL error too.
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => (++scopes === 2 ? Promise.reject(new Error("database unavailable")) : work(stores));
    await expect(executeIntent(deps(stores, clock, meta.port, { inScope }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).rejects.toBe(failure);
    expect(intentOf(stores, intent.id)?.status).toBe("PENDING");
  });

  it("an ordinary intent's failure propagates exactly as before (no recovery transaction, no validation read)", async () => {
    const { stores } = igStores({ providerAction: ["allowed"] }, { capability: "AVAILABLE" });
    const { intent, clock } = seed(stores, { validationAuthorizationId: null });
    const transition = stores.intents.transition.bind(stores.intents);
    const failure = new Error("connection terminated unexpectedly");
    stores.intents.transition = (workspaceId, id, next) => (next.status === "EXECUTING" ? Promise.reject(failure) : transition(workspaceId, id, next));
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => {
      scopes += 1;
      return work(stores);
    };
    await expect(executeIntent(deps(stores, clock, metaHarness().port, { inScope }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).rejects.toBe(failure);
    expect(scopes).toBe(1);
    expect(stores.calls.filter((c) => c.startsWith("validation:"))).toEqual([]);
  });

  it("(22, PRE-LIVE-1) a pause or a mode change after EXECUTING and before the call → BLOCKED from EXECUTING, the credential never opened", async () => {
    for (const [change, code] of [["pause", "PROVIDER_ACTIONS_DISABLED"], ["mode", "MODE_NOT_STANDARD"]] as const) {
      const { stores, v } = igStores({ providerAction: change === "pause" ? ["not_enabled", "paused"] : ["not_enabled"] });
      const { intent, clock } = seed(stores);
      v.reading = bound(intent.id);
      let scopes = 0;
      const inScope: ExecutorDependencies["inScope"] = (work) => {
        if (++scopes === 2 && change === "mode") stores.guardState.mode = "MONITOR_ONLY";
        return work(stores);
      };
      const meta = metaHarness();
      const opened: string[] = [];
      expect(await executeIntent(deps(stores, clock, meta.port, { inScope, opened }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code });
      expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
      expect([meta.posts, opened]).toEqual([[], []]);
    }
  });

  it("(20, X1) a row rewritten under EXECUTING (another run reference or attempt) is never sent: no POST, no transition", async () => {
    for (const rewrite of [{ runReference: "run_forged" }, { attempt: 2 }]) {
      const { stores, v } = igStores();
      const { intent, clock } = seed(stores);
      v.reading = bound(intent.id);
      let scopes = 0;
      const inScope: ExecutorDependencies["inScope"] = (work) => {
        if (++scopes === 2) {
          const row = intentOf(stores, intent.id);
          if (row !== undefined) stores.intentRows.set(`${WORKSPACE}:${intent.id}`, { ...row, ...rewrite });
        }
        return work(stores);
      };
      const meta = metaHarness();
      expect(await executeIntent(deps(stores, clock, meta.port, { inScope }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "noop", status: "EXECUTING" });
      expect(meta.posts).toEqual([]);
      expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING"]);
    }
  });

  it("(20, X1) the stores refuse a same-status rewrite and a transition from a status the row is not in", async () => {
    const { stores } = igStores();
    const { intent } = seed(stores);
    const at = new Date();
    await expect(stores.intents.transition(WORKSPACE, intent.id, { from: "PENDING", status: "PENDING", attempt: 1, runReference: "run_x", outcomeCode: null, at })).rejects.toThrow(/incoherent transition/);
    await expect(stores.intents.transition(WORKSPACE, intent.id, { from: "EXECUTING", status: "OUTCOME_UNKNOWN", attempt: 1, runReference: "run_x", outcomeCode: "RUN_INTERRUPTED", at })).rejects.toThrow(/incoherent transition/);
    expect(intentOf(stores, intent.id)?.status).toBe("PENDING");
  });

  it("(18) a lost response → OUTCOME_UNKNOWN after ONE POST; every later delivery sends nothing", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness("lost");
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
    v.reading = bound(intent.id, { consumedAt: now });
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_again" })).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
    expect(meta.posts).toHaveLength(1);
  });

  it("(19) a redelivered run after EXECUTING never sends: OUTCOME_UNKNOWN (RUN_INTERRUPTED), zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    stores.intentRows.set(`${WORKSPACE}:${intent.id}`, { ...intent, status: "EXECUTING", attempt: 1, runReference: RUN });
    v.reading = bound(intent.id, { consumedAt: now });
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_redelivered" })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
    expect(meta.posts).toEqual([]);
  });

  it("(15) two runs racing on one authorized intent without row locks: the compare-and-set admits ONE EXECUTING; at most ONE POST", async () => {
    // In memory there is no FOR UPDATE: both runs read PENDING. The store's compare-and-set (X1) refuses the second
    // PENDING → EXECUTING, whose recovery finds the intent no longer PENDING and re-throws (nothing recorded, nothing
    // sent). The real row-lock interleaving is in the PostgreSQL suite.
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const results = await Promise.allSettled([
      executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_a" }),
      executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_b" }),
    ]);
    expect(meta.posts).toHaveLength(1);
    expect(stores.history.filter((row) => row.to === "EXECUTING")).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "fulfilled")).toMatchObject({ value: { kind: "confirmed" } });
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(/incoherent transition/);
  });
});

// ── 4 · Step 7B-14H1: the final gate AFTER the key service opened the credential, BEFORE the request leaves ──────────
describe("7B-14H1: decideFinalSend is the one, fail-closed last decision", () => {
  const INTENT = "e1e2e3e4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
  const base = (): FinalSendInput => ({
    expected: { intentId: INTENT, organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectedAccountId: ACCOUNT, targetInteractionId: TARGET, initiatorUserId: USER, validationAuthorizationId: AUTHORIZATION, attempt: 1, runReference: RUN, accountPlatform: "instagram" },
    current: { status: "EXECUTING", attempt: 1, runReference: RUN, validationAuthorizationId: AUTHORIZATION },
    reading: reading({ intentId: INTENT, boundAt: now, consumedAt: now }),
    consumedElsewhere: false,
    initiatorRole: "RESPONDER",
    replyingRoles: ROLES_WITH_PUBLIC_REPLY,
    mode: "STANDARD",
    account: { status: "ACTIVE", platform: "instagram", provider: "meta", providerAssetId: IG_ASSET, connectionStatus: "ACTIVE", credentialId: "cred-1" },
    providerAction: "not_enabled",
    target: { present: true, replyable: true, connectedAccountId: ACCOUNT, workspaceId: WORKSPACE, platform: "instagram" },
    capability: { usable: false, catalogValidationPending: true },
    examined: { preflight: evidenceOf(authorization()), active: { credentialId: "cred-1", connectionId: "conn-1" } },
    credential: { opened: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET }, active: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET } },
  });
  const decide = (change: (input: FinalSendInput) => FinalSendInput) => decideFinalSend(change(base()));

  it("sends only with every live read coherent; a missing grant is stood in for, an exact grant too", () => {
    expect(decideFinalSend(base())).toEqual({ kind: "send" });
    expect(decide((i) => ({ ...i, providerAction: "allowed" }))).toEqual({ kind: "send" });
    expect(decide((i) => ({ ...i, capability: { usable: true, catalogValidationPending: false } }))).toEqual({ kind: "send" });
    // Before opening (no credential part) the same chain decides.
    const { credential, ...beforeOpen } = base();
    expect(credential).toBeDefined();
    expect(decideFinalSend(beforeOpen)).toEqual({ kind: "send" });
  });

  it("(7, X1) a row that is no longer exactly this run's EXECUTING is never sent and never recorded", () => {
    for (const current of [undefined, { status: "OUTCOME_UNKNOWN", attempt: 1, runReference: RUN, validationAuthorizationId: AUTHORIZATION }, { status: "EXECUTING", attempt: 2, runReference: RUN, validationAuthorizationId: AUTHORIZATION }, { status: "EXECUTING", attempt: 1, runReference: "run_other", validationAuthorizationId: AUTHORIZATION }, { status: "EXECUTING", attempt: 1, runReference: RUN, validationAuthorizationId: OTHER }]) {
      expect(decide((i) => ({ ...i, current }))).toEqual({ kind: "not_this_run" });
    }
  });

  it.each([
    ["the authorization unreadable", (i: FinalSendInput): FinalSendInput => ({ ...i, reading: undefined }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the authorization not consumed (incoherent with EXECUTING)", (i: FinalSendInput) => ({ ...i, reading: reading({ intentId: INTENT, boundAt: now }) }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the authorization bound to another intent", (i: FinalSendInput) => ({ ...i, reading: reading({ intentId: OTHER, boundAt: now, consumedAt: now }) }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the authorization revoked", (i: FinalSendInput) => ({ ...i, reading: reading({ intentId: INTENT, boundAt: now, consumedAt: now, revokedAt: now, revokedBy: "ops.synthetic", revocationReason: "test" }) }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the authorization expired (database verdict)", (i: FinalSendInput) => ({ ...i, reading: reading({ intentId: INTENT, boundAt: now, consumedAt: now }, true) }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the authorization for another initiator", (i: FinalSendInput) => ({ ...i, reading: reading({ intentId: INTENT, boundAt: now, consumedAt: now, initiatorUserId: OTHER }) }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["the target validated by another authorization", (i: FinalSendInput) => ({ ...i, consumedElsewhere: true }), "VALIDATION_AUTHORIZATION_UNAVAILABLE"],
    ["(4) the initiator no longer a member", (i: FinalSendInput) => ({ ...i, initiatorRole: undefined }), "INITIATOR_NOT_MEMBER"],
    ["(4) the initiator lost the replying role", (i: FinalSendInput) => ({ ...i, initiatorRole: "ANALYST_VIEWER" }), "PERMISSION_DENIED"],
    ["(1) the workspace Monitor-only", (i: FinalSendInput) => ({ ...i, mode: "MONITOR_ONLY" as const }), "MODE_NOT_STANDARD"],
    ["the workspace mode unreadable", (i: FinalSendInput) => ({ ...i, mode: undefined }), "MODE_NOT_STANDARD"],
    ["(5) the account inactive", (i: FinalSendInput) => ({ ...i, account: i.account === undefined ? undefined : { ...i.account, status: "INACTIVE" } }), "ACCOUNT_INACTIVE"],
    ["(5) the account gone", (i: FinalSendInput) => ({ ...i, account: undefined }), "ACCOUNT_INACTIVE"],
    ["(2, 3) a pause or the emergency block (never stood in for)", (i: FinalSendInput) => ({ ...i, providerAction: "paused" as const }), "PROVIDER_ACTIONS_DISABLED"],
    ["(5) the connection degraded", (i: FinalSendInput) => ({ ...i, account: i.account === undefined ? undefined : { ...i.account, connectionStatus: "DEGRADED" } }), "CONNECTION_UNAVAILABLE"],
    ["the target hidden or gone", (i: FinalSendInput) => ({ ...i, target: undefined }), "TARGET_NOT_PRESENT"],
    ["the target no longer replyable", (i: FinalSendInput) => ({ ...i, target: i.target === undefined ? undefined : { ...i.target, replyable: false } }), "TARGET_NOT_REPLYABLE"],
    ["a capability state other than the catalog's pending validation", (i: FinalSendInput) => ({ ...i, capability: { usable: false, catalogValidationPending: false } }), "CAPABILITY_UNAVAILABLE"],
    ["(6) the credential replaced after it was opened", (i: FinalSendInput) => ({ ...i, credential: { opened: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET }, active: { credentialId: "cred-2", platform: "instagram", providerAssetId: IG_ASSET } } }), "CREDENTIAL_UNREADABLE"],
    ["(6) the credential no longer authorized (removed, its connection or account no longer ACTIVE)", (i: FinalSendInput) => ({ ...i, credential: { opened: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET }, active: undefined } }), "CREDENTIAL_UNREADABLE"],
    ["(6) the opener did not say which credential it opened", (i: FinalSendInput) => ({ ...i, credential: { opened: { credentialId: undefined, platform: "instagram", providerAssetId: IG_ASSET }, active: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET } } }), "CREDENTIAL_UNREADABLE"],
    ["the opened credential names another account", (i: FinalSendInput) => ({ ...i, credential: { opened: { credentialId: "cred-1", platform: "instagram", providerAssetId: "17841400000000002" }, active: { credentialId: "cred-1", platform: "instagram", providerAssetId: IG_ASSET } } }), "TARGET_ACCOUNT_MISMATCH"],
  ] as const)("%s → refuse %s", (_name, change, code) => {
    expect(decide(change)).toEqual({ kind: "refuse", code });
  });
});

describe("7B-14H1: the executor re-checks after the credential is opened and before the ONE POST", () => {
  const bound = (intentId: string) => reading({ intentId, boundAt: now });
  /** A credential use whose key service hands the credential over, then `between` runs, then the executor's callback. */
  const opening = (stores: MemoryStores, opened: string[], between: () => void | Promise<void>, credentialId = "cred-1"): CredentialUse => ({
    withAccess: async (input, use) => {
      opened.push(input.connectedAccountId);
      stores.calls.push("credential:open");
      await between();
      return use({ credential: providerCredential("cred-synthetic", "synthetic-user-token"), account: providerObjectRef("instagram", "asset", IG_ASSET) }, { credentialId });
    },
  });

  it.each([
    ["(1) the workspace turns Monitor-only", "MODE_NOT_STANDARD"],
    ["(2) an exact provider-action pause", "PROVIDER_ACTIONS_DISABLED"],
    ["(4) the initiator loses the replying role", "PERMISSION_DENIED"],
    ["(4) the initiator leaves the workspace", "INITIATOR_NOT_MEMBER"],
    ["(5) the account is deactivated", "ACCOUNT_INACTIVE"],
    ["(5) the connection degrades", "CONNECTION_UNAVAILABLE"],
    ["(6) the credential is replaced", "CREDENTIAL_UNREADABLE"],
    ["(6) the credential is invalidated (no authorized credential)", "CREDENTIAL_UNREADABLE"],
    ["the comment is hidden", "TARGET_NOT_PRESENT"],
  ] as const)("%s between the key service and the POST → BLOCKED %s: ZERO POSTs, consumed, never re-armed", async (name, code) => {
    const { stores, v } = igStores({ providerAction: name.includes("pause") ? ["not_enabled", "not_enabled", "paused"] : ["not_enabled"] });
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const opened: string[] = [];
    const change = (): void => {
      const s = stores.guardState;
      const account = s.account;
      if (name.includes("Monitor-only")) s.mode = "MONITOR_ONLY";
      if (name.includes("loses")) s.role = "ANALYST_VIEWER";
      if (name.includes("leaves")) s.role = undefined;
      if (name.includes("deactivated") && account !== undefined) s.account = { ...account, status: "INACTIVE" };
      if (name.includes("degrades") && account !== undefined) s.account = { ...account, connectionStatus: "DEGRADED" };
      if (name.includes("replaced")) v.activeCredential = "cred-2";
      if (name.includes("invalidated")) v.activeCredential = null;
      if (name.includes("hidden")) stores.targetRows.set(TARGET, { ...(stores.targetRows.get(TARGET) as NonNullable<ReturnType<typeof stores.targetRows.get>>), presence: "hidden" });
    };
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port, { credentials: opening(stores, opened, change) }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code });
    expect(meta.posts).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "BLOCKED", attempt: 1, outcomeCode: code });
    // The refusal is recorded AFTER the credential was opened (the second gate), never before.
    expect(stores.calls.indexOf("credential:open")).toBeLessThan(stores.calls.lastIndexOf("transition:BLOCKED"));
    // Nothing ever sends it again.
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_redelivered" })).toEqual({ kind: "noop", status: "BLOCKED" });
    expect(meta.posts).toEqual([]);
  });

  it("(7, X1) attempt or run reference rewritten between the key service and the POST → nothing sent, nothing recorded", async () => {
    for (const rewrite of [{ runReference: "run_forged" }, { attempt: 2 }]) {
      const { stores, v } = igStores();
      const { intent, clock } = seed(stores);
      v.reading = bound(intent.id);
      const opened: string[] = [];
      const key = `${WORKSPACE}:${intent.id}`;
      const meta = metaHarness();
      const result = await executeIntent(deps(stores, clock, meta.port, { credentials: opening(stores, opened, () => { stores.intentRows.set(key, { ...(stores.intentRows.get(key) as NonNullable<ReturnType<typeof stores.intentRows.get>>), ...rewrite }); }) }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
      expect(result).toEqual({ kind: "noop", status: "EXECUTING" });
      expect([meta.posts, opened.length]).toEqual([[], 1]);
      expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING"]);
    }
  });

  it("(8) a database failure DURING the final check fails closed: no POST, no refusal recorded, the original error; the row stays for reconciliation and a redelivery sends nothing", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const failure = new Error("connection terminated unexpectedly");
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => {
      scopes += 1;
      // Scope 3 = the gate after opening: a read inside it fails.
      if (scopes === 3) return work({ ...stores, guards: { ...stores.guards, workspaceMode: () => Promise.reject(failure) } });
      return work(stores);
    };
    const meta = metaHarness();
    const opened: string[] = [];
    await expect(executeIntent(deps(stores, clock, meta.port, { inScope, opened }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).rejects.toBe(failure);
    expect([meta.posts, opened.length]).toEqual([[], 1]);
    // Never a fictitious refusal, never an OUTCOME_UNKNOWN for a request that did not leave, never PENDING again.
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING"]);
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "EXECUTING", attempt: 1, runReference: RUN, outcomeCode: null });
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_redelivered" })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
    expect(meta.posts).toEqual([]);
  });

  it("(9) the key service fails → BLOCKED CREDENTIAL_UNREADABLE before any POST and before the second gate; consumed, never re-armed", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const kmsDown: CredentialUse = { withAccess: () => Promise.reject(new CredentialUnreadable()) };
    expect(await executeIntent(deps(stores, clock, meta.port, { credentials: kmsDown }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect(meta.posts).toEqual([]);
    // The second gate never ran: the authorized credential was read only before EXECUTING and in the first gate (H1).
    expect(stores.calls.filter((c) => c === "validation:active_credential")).toEqual(["validation:active_credential", "validation:active_credential"]);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
  });

  it("(10, 11, 12) a valid credential and every control intact → exactly ONE POST after the second gate; neither a redelivery nor an OUTCOME_UNKNOWN ever sends again", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const opened: string[] = [];
    let postsAtGate = -1;
    const credentials = opening(stores, opened, () => undefined);
    const original = stores.validation as ValidationExecutionReads;
    const watched: ExecutorStores & MemoryStores = Object.assign(stores, { validation: { ...original, activeCredential: (w: string, a: string) => { postsAtGate = meta.posts.length; return original.activeCredential(w, a); } } });
    expect(await executeIntent(deps(watched, clock, meta.port, { credentials }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "confirmed", providerReplyId: IG_REPLY });
    expect(postsAtGate).toBe(0);
    expect(meta.posts).toHaveLength(1);
    expect(await executeIntent(deps(watched, clock, meta.port, { credentials }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "noop", status: "CONFIRMED" });

    const lost = igStores();
    const seeded = seed(lost.stores);
    lost.v.reading = bound(seeded.intent.id);
    const lostMeta = metaHarness("lost");
    expect(await executeIntent(deps(lost.stores, seeded.clock, lostMeta.port), { workspaceId: WORKSPACE, intentId: seeded.intent.id, runReference: RUN })).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
    for (const run of [RUN, "run_redelivered"]) {
      expect(await executeIntent(deps(lost.stores, seeded.clock, lostMeta.port), { workspaceId: WORKSPACE, intentId: seeded.intent.id, runReference: run })).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
    }
    expect(lostMeta.posts).toHaveLength(1);
  });

  it("(13) an ordinary intent (no authorization) is unchanged: admit, open, ONE call, finish — no gate, no validation read", async () => {
    const { stores } = igStores({ providerAction: ["allowed"] }, { capability: "AVAILABLE" });
    const { intent, clock } = seed(stores, { validationAuthorizationId: null });
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => {
      scopes += 1;
      return work(stores);
    };
    const meta = metaHarness();
    expect(await executeIntent(deps(stores, clock, meta.port, { inScope }), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "confirmed", providerReplyId: IG_REPLY });
    expect(scopes).toBe(2);
    expect(meta.posts).toHaveLength(1);
    expect(stores.calls.filter((c) => c.startsWith("validation:"))).toEqual([]);
  });
});

// ── 7B-14I3H (H1) · the credential opened for the POST is exactly the one the PREFLIGHT examined ─────────────────────
describe("7B-14I3H (H1): examinedCredentialRefusal binds the PREFLIGHT evidence to the credential", () => {
  const a = authorization();
  const active = { credentialId: "cred-1", connectionId: "conn-1" };
  const refusal = (preflight: ValidationPreflightBinding | undefined, ...rest: [current?: typeof active | undefined, accountCredentialId?: string | null]) =>
    examinedCredentialRefusal({ authorization: a, preflight, active: rest.length > 0 ? rest[0] : active, accountCredentialId: rest.length > 1 ? (rest[1] ?? null) : "cred-1" });

  it("holds only when the authorization's own, passed evidence examined exactly the account's authorized credential", () => {
    expect(refusal(evidenceOf(a))).toBeUndefined();
  });

  it.each([
    ["(E) no evidence linked", undefined],
    ["(E) linked to another authorization", evidenceOf(a, { authorizationId: OTHER })],
    ["(D) evidence of another workspace", evidenceOf(a, { workspaceId: OTHER_WORKSPACE })],
    ["(D) evidence of another account", evidenceOf(a, { connectedAccountId: OTHER })],
    ["(E) evidence of another comment", evidenceOf(a, { targetInteractionId: OTHER })],
    ["(E) another run reference than the authorization's", evidenceOf(a, { runReference: "run_other" })],
    ["(E) another recording instant than the authorization's", evidenceOf(a, { recordedAt: new Date(a.preflightCompletedAt.getTime() + 1) })],
    ["(E) evidence that did not pass", evidenceOf(a, { passed: false })],
  ] as const)("%s → VALIDATION_AUTHORIZATION_UNAVAILABLE", (_name, preflight) => {
    expect(refusal(preflight)).toBe("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  });

  it.each([
    ["(B/C) the credential replaced since the PREFLIGHT", { credentialId: "cred-2", connectionId: "conn-1" }, "cred-2"],
    ["(D) the examined credential re-pointed to another connection", { credentialId: "cred-1", connectionId: "conn-2" }, "cred-1"],
    ["(F) the account guard reads another active credential", { credentialId: "cred-1", connectionId: "conn-1" }, "cred-2"],
    ["no authorized credential now", undefined, "cred-1"],
    ["the connection holds no active credential", { credentialId: "cred-1", connectionId: "conn-1" }, null],
  ] as const)("%s → CREDENTIAL_UNREADABLE", (_name, current, accountCredentialId) => {
    expect(refusal(evidenceOf(a), current, accountCredentialId)).toBe("CREDENTIAL_UNREADABLE");
  });
});

describe("7B-14I3H (H1): decideFinalSend refuses any credential the PREFLIGHT did not examine (both gates)", () => {
  const INTENT = "e1e2e3e4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
  const consumed = reading({ intentId: INTENT, boundAt: now, consumedAt: now });
  const base = (): FinalSendInput => ({
    expected: { intentId: INTENT, organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectedAccountId: ACCOUNT, targetInteractionId: TARGET, initiatorUserId: USER, validationAuthorizationId: AUTHORIZATION, attempt: 1, runReference: RUN, accountPlatform: "instagram" },
    current: { status: "EXECUTING", attempt: 1, runReference: RUN, validationAuthorizationId: AUTHORIZATION },
    reading: consumed,
    consumedElsewhere: false,
    initiatorRole: "RESPONDER",
    replyingRoles: ROLES_WITH_PUBLIC_REPLY,
    mode: "STANDARD",
    account: { status: "ACTIVE", platform: "instagram", provider: "meta", providerAssetId: IG_ASSET, connectionStatus: "ACTIVE", credentialId: "cred-1" },
    providerAction: "not_enabled",
    target: { present: true, replyable: true, connectedAccountId: ACCOUNT, workspaceId: WORKSPACE, platform: "instagram" },
    capability: { usable: false, catalogValidationPending: true },
    examined: { preflight: evidenceOf(consumed.authorization), active: { credentialId: "cred-1", connectionId: "conn-1" } },
  });
  const opened = (credentialId: string) => ({ opened: { credentialId, platform: "instagram", providerAssetId: IG_ASSET }, active: { credentialId, platform: "instagram", providerAssetId: IG_ASSET } });

  it("before and after opening: sends with the examined credential", () => {
    expect(decideFinalSend(base())).toEqual({ kind: "send" });
    expect(decideFinalSend({ ...base(), credential: opened("cred-1") })).toEqual({ kind: "send" });
  });

  it("(F) the current authority is coherent (opened = active = the account's) but it is NOT the examined credential → refused in both gates", () => {
    const rotated = { ...base(), account: { ...base().account, credentialId: "cred-2" } as FinalSendInput["account"], examined: { ...base().examined, active: { credentialId: "cred-2", connectionId: "conn-1" } } };
    expect(decideFinalSend(rotated)).toEqual({ kind: "refuse", code: "CREDENTIAL_UNREADABLE" });
    expect(decideFinalSend({ ...rotated, credential: opened("cred-2") })).toEqual({ kind: "refuse", code: "CREDENTIAL_UNREADABLE" });
  });

  it("(E) missing or foreign evidence → refused before the credential is opened", () => {
    expect(decideFinalSend({ ...base(), examined: { ...base().examined, preflight: undefined } })).toEqual({ kind: "refuse", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(decideFinalSend({ ...base(), examined: { ...base().examined, preflight: evidenceOf(consumed.authorization, { authorizationId: OTHER }) } })).toEqual({ kind: "refuse", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
  });
});

describe("7B-14I3H (H1): the executor opens and sends only the credential the PREFLIGHT examined", () => {
  const bound = (intentId: string) => reading({ intentId, boundAt: now });
  const opening = (stores: MemoryStores, opened: string[], between: () => void | Promise<void>, credentialId = "cred-1"): CredentialUse => ({
    withAccess: async (input, use) => {
      opened.push(input.connectedAccountId);
      stores.calls.push("credential:open");
      await between();
      return use({ credential: providerCredential("cred-synthetic", "synthetic-user-token"), account: providerObjectRef("instagram", "asset", IG_ASSET) }, { credentialId });
    },
  });
  const run = (stores: ExecutorStores & MemoryStores, clock: ReturnType<typeof fixedClock>, meta: ReturnType<typeof metaHarness>, intentId: string, credentials?: CredentialUse, inScope?: ExecutorDependencies["inScope"]) =>
    executeIntent(deps(stores, clock, meta.port, { ...(credentials === undefined ? {} : { credentials }), ...(inScope === undefined ? {} : { inScope }) }), { workspaceId: WORKSPACE, intentId, runReference: RUN });

  it("(A) the examined credential, unchanged → exactly ONE POST; the evidence is read before EXECUTING and in both gates", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    expect(await run(stores, clock, meta, intent.id, opening(stores, [], () => undefined))).toEqual({ kind: "confirmed", providerReplyId: IG_REPLY });
    expect(meta.posts).toHaveLength(1);
    const order = stores.calls.filter((c) => c === "validation:examined" || c === "transition:EXECUTING" || c === "credential:open");
    expect(order).toEqual(["validation:examined", "transition:EXECUTING", "validation:examined", "credential:open", "validation:examined"]);
  });

  it("(B) rotated after issuance, before the run → BLOCKED from PENDING: zero POSTs, nothing opened, the authorization NOT spent", async () => {
    const { stores, v } = igStores({ activeCredential: "cred-2" });
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    stores.guardState.account = { ...(stores.guardState.account as NonNullable<typeof stores.guardState.account>), credentialId: "cred-2" };
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await run(stores, clock, meta, intent.id, opening(stores, opened, () => undefined, "cred-2"))).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect([meta.posts, opened]).toEqual([[], []]);
    expect(statusesOf(stores)).toEqual(["PENDING", "BLOCKED"]);
    expect(intentOf(stores, intent.id)).toMatchObject({ status: "BLOCKED", outcomeCode: "CREDENTIAL_UNREADABLE" });
  });

  it("(B) rotated after EXECUTING, before the key service → BLOCKED in the first gate: zero POSTs, nothing decrypted", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => {
      scopes += 1;
      if (scopes === 2) v.activeCredential = "cred-2";
      return work(stores);
    };
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await run(stores, clock, meta, intent.id, opening(stores, opened, () => undefined), inScope)).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect([meta.posts, opened]).toEqual([[], []]);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
  });

  it("(C) rotated after the key service opened the credential → BLOCKED in the second gate: zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await run(stores, clock, meta, intent.id, opening(stores, opened, () => { v.activeCredential = "cred-2"; }))).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect([meta.posts, opened.length]).toEqual([[], 1]);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
  });

  it.each([
    ["(D) evidence of another account", (x: ValidationAuthorization) => evidenceOf(x, { connectedAccountId: OTHER })],
    ["(D) evidence of another connection", (x: ValidationAuthorization) => evidenceOf(x, { connectionId: "conn-2" })],
    ["(E) evidence of another run", (x: ValidationAuthorization) => evidenceOf(x, { runReference: "run_forged" })],
    ["(E) evidence that did not pass", (x: ValidationAuthorization) => evidenceOf(x, { passed: false })],
    ["(F) evidence that examined another credential (the current authority is coherent)", (x: ValidationAuthorization) => evidenceOf(x, { credentialId: "cred-0" })],
  ] as const)("%s → BLOCKED from PENDING: zero POSTs, nothing opened", async (_name, examined) => {
    const { stores, v } = igStores({ examined });
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const opened: string[] = [];
    const result = await run(stores, clock, meta, intent.id, opening(stores, opened, () => undefined));
    expect(result).toMatchObject({ kind: "blocked" });
    expect([meta.posts, opened]).toEqual([[], []]);
    expect(statusesOf(stores)).toEqual(["PENDING", "BLOCKED"]);
  });

  it("(E) no evidence linked at all → BLOCKED VALIDATION_AUTHORIZATION_UNAVAILABLE from PENDING: zero POSTs", async () => {
    const { stores, v } = igStores({ examined: null });
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    expect(await run(stores, clock, meta, intent.id)).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(meta.posts).toEqual([]);
    expect(statusesOf(stores)).toEqual(["PENDING", "BLOCKED"]);
  });

  it("(E) the evidence disappears after EXECUTING (read in the second gate) → BLOCKED: zero POSTs", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const meta = metaHarness();
    const opened: string[] = [];
    expect(await run(stores, clock, meta, intent.id, opening(stores, opened, () => { v.examined = null; }))).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect([meta.posts, opened.length]).toEqual([[], 1]);
  });

  it("(P) the evidence read FAILS in the last gate → no POST, no fictitious refusal; the row stays EXECUTING for reconciliation", async () => {
    const { stores, v } = igStores();
    const { intent, clock } = seed(stores);
    v.reading = bound(intent.id);
    const failure = new Error("connection reset (synthetic)");
    let scopes = 0;
    const inScope: ExecutorDependencies["inScope"] = (work) => {
      scopes += 1;
      const validation = stores.validation as ValidationExecutionReads;
      if (scopes === 3) return work({ ...stores, validation: { ...validation, examinedCredential: () => Promise.reject(failure) } });
      return work(stores);
    };
    const meta = metaHarness();
    const opened: string[] = [];
    await expect(run(stores, clock, meta, intent.id, opening(stores, opened, () => undefined), inScope)).rejects.toBe(failure);
    expect([meta.posts, opened.length]).toEqual([[], 1]);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING"]);
    expect(await executeIntent(deps(stores, clock, meta.port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_redelivered" })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
    expect(meta.posts).toEqual([]);
  });

  it("(G) an ordinary intent (no authorization) never reads the evidence and is otherwise unchanged", async () => {
    const { stores } = igStores({ providerAction: ["allowed"], examined: null }, { capability: "AVAILABLE" });
    const { intent, clock } = seed(stores, { validationAuthorizationId: null });
    const meta = metaHarness();
    expect(await run(stores, clock, meta, intent.id)).toEqual({ kind: "confirmed", providerReplyId: IG_REPLY });
    expect(meta.posts).toHaveLength(1);
    expect(stores.calls).not.toContain("validation:examined");
  });
});

// ── 7B-14I2 · the request resolves the member's OWN live authorization on the server ─────────────────────────────
describe("7B-14I2: resolveValidationAuthorization — the server picks exactly ONE live authorization for (member, target)", () => {
  const context = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION };
  const request = (overrides: Partial<PublicReplyRequest> = {}): PublicReplyRequest => ({ targetInteractionId: TARGET, text: TEXT, idempotencyKey: "form-render-14i2-0001", resolveValidationAuthorization: true, ...overrides });
  /** igStores plus the initiator's live-authorization read (as RLS would answer it). */
  const withLive = (live: readonly { readonly id: string; readonly targetInteractionId: string }[] | "absent") => {
    const h = igStores({ reading: reading() });
    const asked: { workspaceId: string; userId: string; targets: readonly string[] }[] = [];
    if (live !== "absent" && h.stores.validation !== undefined) {
      Object.assign(h.stores.validation, {
        liveForInitiator: (workspaceId: string, userId: string, targets: readonly string[]) => {
          asked.push({ workspaceId, userId, targets });
          return Promise.resolve(live.map((entry) => ({ ...entry, expiresAt: new Date(now.getTime() + 3_600_000) })));
        },
      });
    }
    return { ...h, asked };
  };

  it("exactly one live authorization for this member and this target → the intent names it (bound by the database later)", async () => {
    const { stores, asked } = withLive([{ id: AUTHORIZATION, targetInteractionId: TARGET }]);
    const outcome = await requestPublicReply(stores, fixedClock(), context, request());
    expect(outcome).toMatchObject({ kind: "created", intent: { validationAuthorizationId: AUTHORIZATION, initiatorUserId: USER, targetInteractionId: TARGET } });
    expect(asked).toEqual([{ workspaceId: WORKSPACE, userId: USER, targets: [TARGET] }]);
  });

  it.each([
    ["none", []],
    ["one for another comment", [{ id: AUTHORIZATION, targetInteractionId: OTHER }]],
    ["two (never guessed)", [{ id: AUTHORIZATION, targetInteractionId: TARGET }, { id: OTHER, targetInteractionId: TARGET }]],
    ["no live read composed (fail closed)", "absent"],
  ] as const)("refuses with ONE closed reason when there is %s; nothing is written", async (_name, live) => {
    const { stores } = withLive(live);
    expect(await requestPublicReply(stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect([stores.intentRows.size, stores.replyRows.size, stores.history.length]).toEqual([0, 0, 0]);
  });

  it("the caller can never add an identifier to a resolved request; without the flag the ordinary path is untouched", async () => {
    const both = withLive([{ id: AUTHORIZATION, targetInteractionId: TARGET }]);
    expect(await requestPublicReply(both.stores, fixedClock(), context, request({ validationAuthorizationId: AUTHORIZATION }))).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    expect(both.asked).toEqual([]);
    const ordinary = withLive([{ id: AUTHORIZATION, targetInteractionId: TARGET }]);
    expect(await requestPublicReply(ordinary.stores, fixedClock(), context, request({ resolveValidationAuthorization: false }))).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
    expect(ordinary.asked).toEqual([]);
  });

  it("the same form again answers `existing` (the authorization is bound now, no longer live); a pause still vetoes", async () => {
    const { stores } = withLive([{ id: AUTHORIZATION, targetInteractionId: TARGET }]);
    const first = await requestPublicReply(stores, fixedClock(), context, request());
    expect(first.kind).toBe("created");
    expect(await requestPublicReply(stores, fixedClock(), context, request())).toMatchObject({ kind: "existing" });
    expect(stores.intentRows.size).toBe(1);
    const paused = withLive([{ id: AUTHORIZATION, targetInteractionId: TARGET }]);
    paused.v.providerAction = ["paused"];
    expect(await requestPublicReply(paused.stores, fixedClock(), context, request({ idempotencyKey: "form-render-14i2-0002" }))).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
  });
});
