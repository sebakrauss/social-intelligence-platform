/**
 * Step H6-E — static guards around the stored-interaction confirmation (the only removal authority by re-read):
 *   - list absence never reaches the removal path: no reconciliation code builds a removal observation;
 *   - only an AUTHORITATIVE direct-read not-found (with a healthy connection) may remove; Meta never answers one;
 *   - the provider target is the persistence-issued stored authority's facts only — never a caller's ids;
 *   - the task is INTEGRATION-only and IDs-only; MAIN never reaches the provider or the credential opener;
 *   - Instagram replies never enter a confirmation; coverage, watermarks and conversations are never touched by it.
 */
import { describe, expect, it } from "vitest";
import { NOT_FOUND_AUTHORITIES, TargetNotFoundError } from "@/integrations/providers/contract";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { CONFIRMATION_OUTCOMES, CONFIRM_INTERACTION_TOPIC } from "@/modules/ingestion";
import { codeOf, sourceFiles } from "../support/source-scan";

const APP = "modules/ingestion/application/confirm-interaction.ts";
const JOB = "jobs/confirm-interaction.ts";
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "db", "tools"];

describe("H6-E: removal authority", () => {
  it("a not-found is UNCONFIRMED unless the adapter says otherwise; only the simulator's direct re-read is authoritative", () => {
    expect(NOT_FOUND_AUTHORITIES).toEqual(["authoritative", "unconfirmed"]);
    expect(new TargetNotFoundError("getInteraction").authority).toBe("unconfirmed");
    const authoritative = sourceFiles(["integrations"]).filter((file) => /new TargetNotFoundError\([^)]*"authoritative"\)/.test(codeOf(file)));
    expect(authoritative).toEqual(["integrations/providers/simulator/read-port.ts"]);
    expect([...codeOf("integrations/providers/simulator/read-port.ts").matchAll(/new TargetNotFoundError\(([^)]*)"authoritative"\)/g)].map((m) => m[1])).toEqual(['"getInteraction", ']);
    // Meta: 100/33 is ambiguous by Meta's own definition — every Meta not-found is the unconfirmed default.
    expect(codeOf("integrations/providers/meta/read-port.ts")).not.toMatch(/"authoritative"/);
  });

  it("only the confirmation builds a removal observation, and only from an authoritative direct-read not-found with a healthy connection", () => {
    const builders = sourceFiles(PRODUCTION).filter((file) => /availability: "removed_at_source"/.test(codeOf(file)));
    expect(builders).toEqual([APP]);
    const app = codeOf(APP);
    expect(app).toMatch(/removalBasisFrom\(\{ verifiedProviderSignal: false, directFetch: "not_found", connectionHealthy: checked\.connection\.status === "ACTIVE", notFoundConfirmsRemoval: read\.authoritative \}\)/);
    expect(app).toMatch(/if \(error instanceof TargetNotFoundError\) return \{ kind: "not_found", authoritative: error\.authority === "authoritative", readAt: deps\.clock\.now\(\) \};/);
    // The flag has one source: the adapter's own answer (its type declaration aside).
    expect([...app.matchAll(/authoritative: (?!boolean)/g)]).toHaveLength(1);
    // List absence never reaches it: the reconciliation runtime builds no removal and calls no confirmation.
    const reconciliation = codeOf("modules/ingestion/application/reconciliation.ts");
    expect(reconciliation).not.toMatch(/removed_at_source|removalBasisFrom|direct_fetch_confirmed|confirmStoredInteraction|requestInteractionConfirmation|enqueueConfirmation/);
  });

  it("the provider target is the persistence-issued stored authority's facts — never a caller's ids, never a bare id", () => {
    const app = codeOf(APP);
    expect(app).toMatch(/const authority = await scope\.authority\.storedInteraction\(workspaceId, record\.platform, record\.providerInteractionId\);/);
    const target = app.slice(app.indexOf("const stored: StoredInteractionProvenance = Object.freeze({"), app.indexOf("});", app.indexOf("const stored: StoredInteractionProvenance")));
    expect(target).toMatch(/providerObjectRef\(platform, "asset", authority\.providerAssetId\)/);
    expect(target).toMatch(/providerObjectRef\(platform, "content", authority\.contentId\)/);
    expect(target).toMatch(/providerObjectRef\(platform, "interaction", authority\.interactionId\)/);
    expect(target).toMatch(/authority\.parentId === null \? null : providerObjectRef\(platform, "interaction", authority\.parentId\)/);
    expect(target).toMatch(/interactionKind: authority\.kind/);
    expect(target).not.toMatch(/input\.|payload|record\.provider/);
    // The stored authority is issued only by the interactions persistence layer (H6-A1, TL decision 1).
    expect(codeOf("server/persistence/ingestion.ts")).toMatch(/storedInteraction: \(workspaceId, platform, providerInteractionId\) => loadStoredInteractionAuthority\(tx, workspaceId, platform, providerInteractionId\),/);
    // A FOUND node must match its authority before anything is applied.
    expect(app).toMatch(/const mismatches = verifyStoredReread\(\s+prepared\.authority,/);
    expect(app).toMatch(/if \(mismatches\.length > 0\) return done\("PROVIDER_CONTRACT_AMBIGUOUS"\);/);
  });

  it("the job reads two UUID subjects and nothing else; the task is INTEGRATION-only and IDs-only", () => {
    const job = codeOf(JOB);
    expect([...job.matchAll(/subjectIds\["([a-z_]+)"\]/g)].map((m) => m[1])).toEqual(["interaction_id", "connected_account_id"]);
    expect(job).not.toMatch(/provider_interaction_id|providerInteractionId|provider_content_id/);
    const task = PRODUCTION_TASKS.tenant(CONFIRM_INTERACTION_TOPIC);
    expect([task?.executionPlane, task?.subjects]).toEqual(["integration", ["connected_account_id", "interaction_id"]]);
    expect(codeOf("jobs/trigger/integration/ingestion.ts")).toMatch(/defineTenantStepTask\(PRODUCTION_TASKS, "ingestion\.confirm_interaction", \(context\) => runConfirmInteraction\(context\)\)/);
    for (const file of sourceFiles(["jobs/trigger/main"])) expect(codeOf(file), file).not.toMatch(/confirm_interaction|runConfirmInteraction/);
    // The only producer is the internal request (job scope): no web, UI or scheduler names the topic.
    for (const file of sourceFiles(["app", "ui", "server"])) expect(codeOf(file), file).not.toMatch(/confirm_interaction|requestInteractionConfirmation|confirmStoredInteraction/);
  });

  it("Instagram replies never enter a confirmation: the capability must read the KIND, and the adapter refuses a stored IG reply", () => {
    expect(codeOf(APP)).toMatch(/if \(!coveredInteractionKinds\(availabilityInput\(checked\.availability\)\)\.includes\(record\.kind\)\) return done\("CAPABILITY_UNAVAILABLE"\);/);
    expect(codeOf("integrations/providers/meta/read-port.ts")).toMatch(/if \(stored && access\.account\.platform === "instagram" && provenance\.interactionKind !== "comment"\) throw new TargetNotEligibleError\("getInteraction", "unsupported_for_target"\);/);
  });

  it("a confirmation touches no coverage, no watermark and no conversation directly (one canonical path only)", () => {
    const app = codeOf(APP);
    expect(app).not.toMatch(/coverage\.record|recordSlice|recordCoverage|setWatermark|advanceWatermark|ensureForAnchor|attachSubtree|conversations\./);
    expect([...app.matchAll(/ingestInteractionFact\(/g)]).toHaveLength(1);
    expect([...app.matchAll(/port\.getInteraction\(/g)]).toHaveLength(1);
  });

  it("the outcome vocabulary is closed", () => {
    expect(CONFIRMATION_OUTCOMES).toEqual(["FOUND", "AUTHORITATIVE_NOT_FOUND", "TEMPORARY_FAILURE", "AUTHORIZATION_FAILURE", "CAPABILITY_UNAVAILABLE", "PROVIDER_CONTRACT_AMBIGUOUS", "INTERACTION_NOT_FOUND", "NOT_ELIGIBLE"]);
  });
});
