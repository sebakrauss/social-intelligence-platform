/**
 * Step H6-B — the trusted adapter boundary (provider InteractionDto → InteractionSourceFact) and the parents-first batch
 * order, without a database. The DTOs come from the simulator's own listing (no hand-written DTO for the main path);
 * the edge cases patch one field of a listed DTO. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@/domain/ids";
import { parseInstant } from "@/domain/instant";
import { parseIsoInstant, type InteractionDto, type Page, type PageCursor, type TimeWindow } from "@/integrations/providers/contract";
import { SourceFactRejectedError, interactionSourceFactFromDto, orderParentsFirst, textHashOf, type SourceFactContext } from "@/modules/ingestion";
import { AUTHOR_LABEL_MAX_LENGTH, parseInteractionSourceFact, type InteractionSourceFact } from "@/modules/interactions";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing");
  return value;
};
const WINDOW: TimeWindow = { from: must(parseIsoInstant("2026-01-01T00:00:00.000Z")), to: must(parseIsoInstant("2027-01-01T00:00:00.000Z")) };
const CONTEXT: SourceFactContext = {
  workspaceId: must(parseWorkspaceId("0b6b0b6b-0000-4000-8000-000000000002")),
  connectedAccountId: "0b6b0b6b-0000-4000-8000-000000000001",
  providerAssetId: "fb_page_aurora",
  mechanism: "reconciliation",
  operation: "listInteractions",
  provenance: "listed",
  observedAt: must(parseInstant("2026-09-15T12:00:00.000Z")),
  catalogRevision: 5,
  profileRevision: 5,
};

async function listedFacebook(): Promise<InteractionDto[]> {
  const sim = createBaselineSimulator();
  const access = sim.access("cred_meta_main", "fb_page_aurora");
  const out: InteractionDto[] = [];
  let cursor: PageCursor | null = null;
  for (;;) {
    const page: Page<InteractionDto> = (await sim.read.listInteractions(access, { kind: "account" }, WINDOW, cursor)).data;
    out.push(...page.items);
    if (page.next.kind === "end") return out;
    cursor = page.next.cursor;
  }
}
const byId = (dtos: readonly InteractionDto[], id: string): InteractionDto => must(dtos.find((d) => d.ref.id === id));
const rejection = (run: () => unknown): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof SourceFactRejectedError) return error.violations;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("interactionSourceFactFromDto (trusted mapping)", () => {
  it("maps a listed comment and a listed reply exactly, with the SHA-256 of the exact text", async () => {
    const dtos = await listedFacebook();
    const comment = interactionSourceFactFromDto(byId(dtos, "fb_c_001"), CONTEXT);
    const source = must(byId(dtos, "fb_c_001").text ?? undefined);
    expect(comment.identity).toEqual({ interactionId: "fb_c_001", contentId: "fb_post_organic_01", parentId: null, kind: "comment" });
    expect(comment.text).toEqual({ sourceText: source, textHash: createHash("sha256").update(source, "utf8").digest("hex") });
    expect(textHashOf(source)).toBe(comment.text.textHash);
    expect(comment.scope).toEqual({ workspaceId: CONTEXT.workspaceId, connectedAccountId: CONTEXT.connectedAccountId, platform: "facebook", providerAssetId: "fb_page_aurora" });
    expect(comment.provenance).toEqual({ mechanism: "reconciliation", operation: "listInteractions", provenance: "listed" });
    const reply = interactionSourceFactFromDto(byId(dtos, "fb_c_002"), CONTEXT);
    expect(reply.identity).toMatchObject({ parentId: "fb_c_001", kind: "reply" });
    expect(reply.author).toMatchObject({ ref: "fb_author_aurora", role: "account_identity" });
  });

  it("an explicit removal carries no text and the explicit-signal basis", async () => {
    const dto = byId(await listedFacebook(), "fb_c_005");
    const fact = interactionSourceFactFromDto({ ...dto, text: null, availability: "removed_at_source" }, CONTEXT);
    expect(fact.text).toEqual({ sourceText: null, textHash: null });
    expect(fact.state).toMatchObject({ availability: "removed_at_source", removalBasis: "explicit_provider_signal" });
  });

  it("fails closed without a provider creation time, on a cross-platform content, or on an invalid id", async () => {
    const dto = byId(await listedFacebook(), "fb_c_001");
    expect(rejection(() => interactionSourceFactFromDto({ ...dto, timestamps: { ...dto.timestamps, createdAt: null } }, CONTEXT)).length).toBeGreaterThan(0);
    expect(rejection(() => interactionSourceFactFromDto({ ...dto, content: { ...dto.content, platform: "instagram" } }, CONTEXT))).toEqual(["SCOPE_INVALID"]);
    expect(rejection(() => interactionSourceFactFromDto(dto, { ...CONTEXT, providerAssetId: "not a provider id" })).length).toBeGreaterThan(0);
  });

  it("drops an over-long label (display aid only) and keeps the interaction", async () => {
    const dto = byId(await listedFacebook(), "fb_c_001");
    const long = "x".repeat(AUTHOR_LABEL_MAX_LENGTH + 1);
    expect(interactionSourceFactFromDto({ ...dto, author: { ...dto.author, displayName: long, handle: null } }, CONTEXT).author.label).toBeNull();
    expect(interactionSourceFactFromDto({ ...dto, author: { ...dto.author, displayName: null } }, CONTEXT).author.label).toBe(dto.author.handle);
  });
});

describe("orderParentsFirst (batch order)", () => {
  const facts = async (): Promise<InteractionSourceFact[]> => (await listedFacebook()).filter((d) => d.content.id === "fb_post_organic_01").map((d) => interactionSourceFactFromDto(d, CONTEXT));
  const ids = (list: readonly InteractionSourceFact[]): string[] => list.map((f) => f.identity.interactionId);

  it("puts every parent before its replies and otherwise keeps the listing order", async () => {
    const listed = await facts();
    expect(ids(listed).indexOf("fb_c_003")).toBeLessThan(ids(listed).indexOf("fb_c_001"));
    const ordered = orderParentsFirst(listed);
    expect(ordered).toHaveLength(listed.length);
    expect(ids(ordered).indexOf("fb_c_001")).toBeLessThan(ids(ordered).indexOf("fb_c_002"));
    expect(ids(ordered).indexOf("fb_c_002")).toBeLessThan(ids(ordered).indexOf("fb_c_003"));
    const topLevel = ids(listed).filter((id) => !["fb_c_001", "fb_c_002", "fb_c_003"].includes(id));
    expect(ids(ordered).filter((id) => topLevel.includes(id))).toEqual(topLevel);
  });

  it("keeps every sighting of a repeated id, leaves an out-of-batch parent alone and terminates on a cycle", async () => {
    const listed = await facts();
    const reply = must(listed.find((f) => f.identity.interactionId === "fb_c_003"));
    const twice = orderParentsFirst([reply, ...listed, reply]);
    expect(ids(twice).filter((id) => id === "fb_c_003")).toHaveLength(3);
    expect(ids(orderParentsFirst([reply]))).toEqual(["fb_c_003"]);
    const parsed = parseInteractionSourceFact({ ...reply, identity: { ...reply.identity, interactionId: "fb_c_002", parentId: "fb_c_003" } });
    if (!parsed.ok) throw new Error("fact");
    expect(ids(orderParentsFirst([reply, parsed.fact])).sort()).toEqual(["fb_c_002", "fb_c_003"]);
  });
});
