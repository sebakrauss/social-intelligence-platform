/**
 * The simulator's contract harness: the baseline scenario's TikTok account (paginated content shared by two
 * ads) plus Facebook webhook fixtures, with every normalized error produced through public ports and explicit
 * fault rules.
 */
import { isoInstant, providerObjectRef, type ProviderAccess, type TimeWindow, parseIsoInstant } from "@/integrations/providers/contract";
import { createSimulatorReadPort, signSimulatorDelivery, SimulatorWorld } from "@/integrations/providers/simulator";
import { createSimulatorMutationPort } from "@/integrations/providers/simulator/mutation-port";
import type { ProviderContractHarness } from "../contract/harness";
import { deliveryBody, loadScenario, rawBody } from "./fixtures";

/** A synthetic signing key for simulated webhooks (test-only, not a secret). */
export const SIM_SIGNING_KEY = "synthetic-webhook-signing-key-for-tests";

export const FULL_WINDOW: TimeWindow = {
  from: parseIsoInstant("2026-09-01T00:00:00.000Z") ?? (() => { throw new Error("instant"); })(),
  to: parseIsoInstant("2026-09-15T00:00:00.000Z") ?? (() => { throw new Error("instant"); })(),
};

export function createBaselineSimulator() {
  const world = new SimulatorWorld(loadScenario("baseline"));
  const read = createSimulatorReadPort(world, { webhookSigningKey: SIM_SIGNING_KEY });
  const mutation = createSimulatorMutationPort(world);
  const access = (credentialId: string, assetId: string): ProviderAccess => ({ credential: world.credential(credentialId), account: world.assetRef(assetId) });
  return { world, read, mutation, access };
}

export function signedFixture(name: string, sentAt = "2026-09-15T12:00:00.000Z", receivedAt = sentAt) {
  const { deliveryId, body } = deliveryBody(name);
  const at = parseIsoInstant(sentAt);
  const received = parseIsoInstant(receivedAt);
  if (at === undefined || received === undefined) throw new Error("instant");
  return signSimulatorDelivery(SIM_SIGNING_KEY, body, { sentAt: at, deliveryId, receivedAt: received });
}

export function simulatorContractHarness(): ProviderContractHarness {
  const sim = createBaselineSimulator();
  const { world, read, mutation, access } = sim;
  const tiktok = access("cred_tiktok_main", "tt_acct_aurora");
  const meta = (asset: string) => access("cred_meta_main", asset);
  const tt = <K extends "content" | "interaction" | "author">(kind: K, id: string) => providerObjectRef("tiktok", kind, id);

  return {
    name: "simulator (baseline scenario)",
    provider: "simulator",
    read,
    mutation,
    reset: () => {
      world.reset();
    },
    discoveryCredential: world.credential("cred_meta_main"),
    contentAccess: tiktok,
    adAccess: access("cred_tiktok_main", "tt_adv_200"),
    window: FULL_WINDOW,
    paginatedContent: tt("content", "tt_video_multi_20"),
    emptyContent: tt("content", "tt_video_quiet_22"),
    sharedContent: tt("content", "tt_video_multi_20"),
    mutationTarget: tt("interaction", "tt_c_001"),
    blockableAuthor: tt("author", "tt_user_04"),
    subscribable: tiktok,
    refreshable: world.credential("cred_meta_expiring"),
    webhooks: {
      valid: () => signedFixture("single_created"),
      tampered: () => {
        const request = signedFixture("single_created");
        return { ...request, rawBody: request.rawBody.replace("fb_c_001", "fb_c_005") };
      },
      unsigned: () => {
        const request = signedFixture("single_created");
        return { ...request, headers: { "content-type": "application/json" } };
      },
      stale: () => signedFixture("single_created", "2026-09-15T11:00:00.000Z", "2026-09-15T12:00:00.000Z"),
      malformed: () => {
        const at = parseIsoInstant("2026-09-15T12:00:00.000Z");
        if (at === undefined) throw new Error("instant");
        return signSimulatorDelivery(SIM_SIGNING_KEY, rawBody("truncated_json"), { sentAt: at, deliveryId: "dlv-0006" });
      },
      withUnknownEvent: () => signedFixture("batch_with_unknown"),
      outOfOrder: () => [signedFixture("edit_late"), signedFixture("create_early")],
    },
    errorCases: [
      {
        name: "listing beyond the provider's rate budget",
        kind: "rate_limited",
        invoke: () => {
          world.applyFaultPreset("rate_limited_listing");
          return read.listInteractions(tiktok, { kind: "account" }, FULL_WINDOW, null);
        },
      },
      {
        name: "provider server error on a re-fetch",
        kind: "transient",
        invoke: () => {
          world.applyFaultPreset("transient_refetch");
          return read.getInteraction(tiktok, tt("interaction", "tt_c_001"));
        },
      },
      {
        name: "account granted without interaction access",
        kind: "permission_missing",
        invoke: () => read.listInteractions(meta("ig_acct_limited"), { kind: "account" }, FULL_WINDOW, null),
      },
      {
        name: "re-fetch of an object the provider doesn't return",
        kind: "target_not_found",
        invoke: () => read.getInteraction(tiktok, tt("interaction", "tt_c_does_not_exist")),
      },
      {
        name: "hide refused for a target with a simulated restriction",
        kind: "target_not_eligible",
        invoke: () => mutation.hide(meta("fb_page_aurora"), providerObjectRef("facebook", "interaction", "fb_c_010")),
      },
      {
        name: "revoked credential",
        kind: "credential_invalid",
        invoke: () => read.describeAccount(access("cred_revoked", "fb_page_aurora")),
      },
      {
        name: "reply rejected by provider policy",
        kind: "permanent_rejected",
        invoke: () => {
          world.applyFaultPreset("permanent_reply_rejection");
          return mutation.replyPublicly(tiktok, tt("interaction", "tt_c_001"), "Gracias (test)", { key: "k-permanent" });
        },
      },
      {
        name: "reply timed out after the provider accepted it",
        kind: "outcome_unknown",
        invoke: () => {
          world.applyFaultPreset("reply_timeout_after_send");
          return mutation.replyPublicly(tiktok, tt("interaction", "tt_c_001"), "Gracias (test)", { key: "k-unknown" });
        },
      },
    ],
    secrets: world.scenario.credentials.map((c) => c.secret),
  };
}

export const SCENARIO_NOW = isoInstant(new Date("2026-09-15T12:00:00.000Z"));
