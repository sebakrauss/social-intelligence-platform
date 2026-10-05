/**
 * Simulator implementation of the provider READ port. Deterministic, fixture-backed, no network.
 *
 * Ordering: newest first (provider time desc, then id asc) for content and interactions; paid context as
 * campaigns, ad groups, ads, each by id. Cursors are opaque, bound to operation, scope and window; a cursor
 * from anywhere else is rejected (`invalid_cursor`). Removed-at-source and vanished objects are not listed;
 * a direct fetch returns a tombstone only when the "provider" signaled the removal (TA §47.3).
 */
import type { CredentialRefreshResult, ProviderAccess, StateObservationDto, StateTarget } from "../contract/dto";
import { PermanentRejectedError, TargetNotEligibleError, TargetNotFoundError, type ProviderOperation } from "../contract/errors";
import { isoInstant, type IsoInstant, type ProviderObjectRef } from "../contract/identity";
import { parsePageCursor, type Page, type PageCursor, type TimeWindow } from "../contract/pagination";
import { providerCredential, type ProviderCredential } from "../contract/credential";
import type { InteractionScope, ProviderReadPort } from "../contract/read-port";
import type { PaidContextItem } from "../contract/dto";
import {
  accountDescriptionDto,
  adDto,
  adGroupDto,
  campaignDto,
  contentDto,
  interactionDto,
  simRaw,
  socialAssetDto,
} from "./normalize";
import { parseSimulatorWebhook } from "./webhooks";
import { asPromise, type InteractionState, type SimulatorWorld } from "./world";
import { WebhookRejectedError } from "../contract/webhooks";

const REFRESH_THRESHOLD_SECONDS = 7 * 24 * 3600;
const REFRESHED_LIFETIME_SECONDS = 60 * 24 * 3600;

export interface SimulatorReadPortOptions {
  /** Synthetic key used to verify simulated webhook signatures (never a production secret). */
  readonly webhookSigningKey: string;
}

interface CursorState {
  readonly o: string;
  readonly s: string;
  readonly f: string;
  readonly t: string;
  readonly n: number;
}

function encodeCursor(state: CursorState): PageCursor {
  const cursor = parsePageCursor(`sim1.${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`);
  if (cursor === undefined) throw new TypeError("cursor encoding failed");
  return cursor;
}

function decodeCursor(operation: ProviderOperation, cursor: PageCursor, expect: Omit<CursorState, "n">): number {
  try {
    if (!cursor.startsWith("sim1.")) throw new Error("prefix");
    const state = JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8")) as Partial<CursorState>;
    if (state.o !== expect.o || state.s !== expect.s || state.f !== expect.f || state.t !== expect.t) throw new Error("scope");
    if (typeof state.n !== "number" || !Number.isInteger(state.n) || state.n < 0) throw new Error("offset");
    return state.n;
  } catch {
    throw new PermanentRejectedError(operation, "invalid_cursor");
  }
}

function paginate<T>(
  operation: ProviderOperation,
  items: readonly T[],
  pageSize: number,
  cursor: PageCursor | null,
  scope: Omit<CursorState, "n">,
): Page<T> {
  const offset = cursor === null ? 0 : decodeCursor(operation, cursor, scope);
  const slice = items.slice(offset, offset + pageSize);
  const end = offset + pageSize >= items.length;
  return { items: slice, next: end ? { kind: "end" } : { kind: "more", cursor: encodeCursor({ ...scope, n: offset + pageSize }) } };
}

function checkWindow(operation: ProviderOperation, window: TimeWindow): void {
  if (!(Date.parse(window.from) < Date.parse(window.to))) throw new PermanentRejectedError(operation, "invalid_request");
}

const inWindow = (at: IsoInstant, window: TimeWindow): boolean => at >= window.from && at < window.to;

const newestFirst = <T extends { readonly id: string }>(time: (item: T) => string) => (a: T, b: T): number =>
  time(a) === time(b) ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : time(a) < time(b) ? 1 : -1;

export function createSimulatorReadPort(world: SimulatorWorld, options: SimulatorReadPortOptions): ProviderReadPort {
  const pageSize = world.scenario.pageSize;
  const auth = (access: ProviderAccess) => ({ credential: access.credential, account: access.account.id });

  const ownedInteraction = (operation: ProviderOperation, access: ProviderAccess, id: string): InteractionState => {
    const state = world.interaction(id);
    const content = state === undefined ? undefined : world.content(state.content);
    if (state === undefined || content?.account !== access.account.id || state.presence === "vanished") throw new TargetNotFoundError(operation);
    return state;
  };

  const listedInteraction = (state: InteractionState): boolean => state.presence === "present";

  return {
    provider: "simulator",

    discoverAssets(credential) {
      return asPromise(() =>
        world.execute("discoverAssets", { credential }, [], () => {
          const state = world.credentialState(credential.id);
          return (state?.assets ?? [])
            .map((id) => world.asset(id))
            .filter((asset) => asset !== undefined)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((asset) => socialAssetDto(world, asset));
        }),
      );
    },

    describeAccount(access) {
      return asPromise(() =>
        world.execute("describeAccount", auth(access), [], () => {
          const asset = world.asset(access.account.id);
          if (asset === undefined) throw new TargetNotFoundError("describeAccount");
          return accountDescriptionDto(world, asset);
        }),
      );
    },

    listContent(access, window, cursor) {
      return asPromise(() =>
        world.execute("listContent", auth(access), [], () => {
          checkWindow("listContent", window);
          const items = world
            .contents()
            .filter((c) => c.account === access.account.id && c.availability !== "removed_at_source" && inWindow(c.publishedAt, window))
            .sort(newestFirst((c) => c.publishedAt))
            .map((c) => contentDto(world, c));
          return paginate("listContent", items, pageSize, cursor, { o: "listContent", s: access.account.id, f: window.from, t: window.to });
        }),
      );
    },

    listInteractions(access, scope: InteractionScope, window, cursor) {
      const targets = scope.kind === "content" ? [scope.content.id] : [];
      return asPromise(() =>
        world.execute("listInteractions", auth(access), targets, () => {
          checkWindow("listInteractions", window);
          if (scope.kind === "content") {
            const content = world.content(scope.content.id);
            if (content?.account !== access.account.id) throw new TargetNotFoundError("listInteractions");
          }
          const contentIds = new Set(
            world.contents().filter((c) => c.account === access.account.id && (scope.kind === "account" || c.id === scope.content.id)).map((c) => c.id),
          );
          const items = world
            .interactions()
            .filter((i) => contentIds.has(i.content) && listedInteraction(i) && inWindow(i.createdAt, window))
            .sort(newestFirst((i) => i.createdAt))
            .map((i) => interactionDto(world, i));
          const scopeKey = scope.kind === "content" ? `${access.account.id}/${scope.content.id}` : `${access.account.id}/*`;
          return paginate("listInteractions", items, pageSize, cursor, { o: "listInteractions", s: scopeKey, f: window.from, t: window.to });
        }),
      );
    },

    getInteraction(access, ref) {
      return asPromise(() =>
        world.execute("getInteraction", auth(access), [ref.id], () => interactionDto(world, ownedInteraction("getInteraction", access, ref.id))),
      );
    },

    getContent(access, ref) {
      return asPromise(() =>
        world.execute("getContent", auth(access), [ref.id], () => {
          const content = world.content(ref.id);
          if (content?.account !== access.account.id) throw new TargetNotFoundError("getContent");
          return contentDto(world, content);
        }),
      );
    },

    getCurrentState(access, target: StateTarget) {
      return asPromise(() =>
        world.execute("getCurrentState", auth(access), [target.id], (): StateObservationDto => {
          const observedAt = world.now();
          const base = { target, observedAt };
          if (target.kind === "interaction") {
            const state = world.interaction(target.id);
            const owned = state !== undefined && world.content(state.content)?.account === access.account.id;
            if (state === undefined || !owned || state.presence === "vanished") {
              return { ...base, presence: "not_returned", visibility: "unknown", blocked: null, basis: "direct_fetch", rawReference: null };
            }
            if (state.presence === "removed_signaled") {
              return { ...base, presence: "removed_at_source", visibility: null, blocked: null, basis: "provider_signal", rawReference: simRaw(world, "interaction", state.id, state.revision) };
            }
            return { ...base, presence: "present", visibility: state.visibility, blocked: null, basis: "provider_field", rawReference: simRaw(world, "interaction", state.id, state.revision) };
          }
          if (target.kind === "content") {
            const content = world.content(target.id);
            if (content?.account !== access.account.id) {
              return { ...base, presence: "not_returned", visibility: null, blocked: null, basis: "direct_fetch", rawReference: null };
            }
            const presence = content.availability === "removed_at_source" ? "removed_at_source" : content.availability === "unknown" ? "unknown" : "present";
            return { ...base, presence, visibility: null, blocked: null, basis: presence === "removed_at_source" ? "provider_signal" : "provider_field", rawReference: simRaw(world, "content", content.id) };
          }
          const author = world.author(target.id);
          if (author?.platform !== access.account.platform) {
            return { ...base, presence: "not_returned", visibility: null, blocked: null, basis: "direct_fetch", rawReference: null };
          }
          return { ...base, presence: "present", visibility: null, blocked: world.isBlocked(access.account.id, author.id), basis: "provider_field", rawReference: simRaw(world, "author", author.id) };
        }),
      );
    },

    retrievePaidContext(access, window, cursor) {
      return asPromise(() =>
        world.execute("retrievePaidContext", auth(access), [], () => {
          checkWindow("retrievePaidContext", window);
          if (world.asset(access.account.id)?.assetClass !== "ad_account") throw new TargetNotEligibleError("retrievePaidContext", "wrong_target_kind");
          const mine = <T extends { readonly adAccount: string; readonly createdAt: string; readonly id: string }>(list: readonly T[]) =>
            list.filter((p) => p.adAccount === access.account.id && p.createdAt < window.to).sort((a, b) => (a.id < b.id ? -1 : 1));
          const s = world.scenario;
          const items: PaidContextItem[] = [
            ...mine(s.campaigns).map((c) => campaignDto(world, c)),
            ...mine(s.adGroups).map((g) => adGroupDto(world, g)),
            ...mine(s.ads).map((ad) => adDto(world, ad)),
          ];
          return paginate("retrievePaidContext", items, pageSize, cursor, { o: "retrievePaidContext", s: access.account.id, f: window.from, t: window.to });
        }),
      );
    },

    parseWebhook(request) {
      try {
        const result = parseSimulatorWebhook(options.webhookSigningKey, world.scenario.webhookToleranceSeconds, request);
        world.recordWebhookParse("ok");
        return Promise.resolve(result);
      } catch (error) {
        world.recordWebhookParse(error instanceof WebhookRejectedError ? `rejected_${error.reason}` : "error");
        return Promise.reject(error instanceof Error ? error : new Error("webhook_parse_failed"));
      }
    },

    subscribe(access) {
      return asPromise(() => world.execute("subscribe", auth(access), [], () => subscription(world, "subscribe", access.account, true)));
    },

    unsubscribe(access) {
      return asPromise(() => world.execute("unsubscribe", auth(access), [], () => subscription(world, "unsubscribe", access.account, false)));
    },

    refreshCredential(credential: ProviderCredential) {
      return asPromise(() =>
        world.execute("refreshCredential", { credential }, [], (): CredentialRefreshResult => {
          const state = world.credentialState(credential.id);
          if (state === undefined) throw new TargetNotFoundError("refreshCredential");
          if (state.refresh === "not_supported") return { status: "not_supported" };
          const now = Date.parse(world.now());
          if (state.expiresAt === null || Date.parse(state.expiresAt) - now > REFRESH_THRESHOLD_SECONDS * 1000) {
            return { status: "not_needed", expiresAt: state.expiresAt };
          }
          const refreshed = world.rotateCredentialSecret(state.id, isoInstant(new Date(now + REFRESHED_LIFETIME_SECONDS * 1000)));
          return { status: "refreshed", credential: providerCredential(refreshed.id, refreshed.secret), expiresAt: refreshed.expiresAt };
        }),
      );
    },
  };
}

function subscription(world: SimulatorWorld, operation: ProviderOperation, account: ProviderObjectRef<"asset">, subscribe: boolean) {
  const asset = world.asset(account.id);
  if (asset === undefined) throw new TargetNotFoundError(operation);
  if (asset.webhooks === "not_supported") throw new TargetNotEligibleError(operation, "unsupported_for_target");
  const changed = world.setSubscribed(asset.id, subscribe);
  return { asset: account, state: subscribe ? ("subscribed" as const) : ("unsubscribed" as const), changed };
}
