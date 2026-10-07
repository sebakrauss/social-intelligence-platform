/**
 * Step 5F, without a database: the M-01 / TA-Q-02 rule split, the closed Move vocabularies, and their alignment with
 * migration 0010 (the definers derive topics, steps and actions from the same closed strings) and the task registry.
 * The database behavior is proven in tests/db/suites/moves.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_EVALUATION_TOPIC,
  MOVE_REASON_CODES,
  MOVE_STEPS,
  MOVE_TOPICS,
  activeElsewhereReason,
  singleWorkspaceRule,
  type IncomingMove,
} from "@/modules/connections";
import { MOVE_AUDIT_STEPS, RETRY_ACTIVATION_STEP, SINGLE_WORKSPACE_INDEXES, isRetryable } from "@/modules/connections/domain/model";
import { PRODUCTION_TASKS } from "@/jobs/registry";

const root = path.resolve(import.meta.dirname, "../../..");
const migration = readFileSync(path.join(root, "db/migrations/0010_connected_account_moves.sql"), "utf8");
const original = readFileSync(path.join(root, "db/migrations/0007_connections_and_credentials.sql"), "utf8");

describe("M-01 and the TEMPORARY TA-Q-02 restriction stay distinct", () => {
  it("content-bearing assets fall under M-01, ad accounts under TA-Q-02, each with its own closed reason", () => {
    expect(singleWorkspaceRule("content_bearing")).toBe("M-01");
    expect(singleWorkspaceRule("ad_account")).toBe("TA-Q-02");
    expect(activeElsewhereReason("M-01")).toBe("ASSET_ACTIVE_ELSEWHERE");
    expect(activeElsewhereReason("TA-Q-02")).toBe("AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION");
  });

  it("each rule maps from exactly its own 0007 unique index", () => {
    expect(SINGLE_WORKSPACE_INDEXES).toEqual({
      connected_accounts_m01_active_content_asset: "M-01",
      connected_accounts_taq02_tmp_ad_account_single_workspace: "TA-Q-02",
    });
    for (const index of Object.keys(SINGLE_WORKSPACE_INDEXES)) expect(original).toContain(`create unique index ${index}`);
  });
});

describe("closed Move vocabularies match migration 0010", () => {
  it("the reason list is 0007's plus exactly the TA-Q-02 reason and the destination's generic SOURCE_RELEASE_REJECTED", () => {
    const rewrite = /add constraint asset_moves_reason_code_check check \(reason_code in \(([^)]*)\)\) not valid;/.exec(migration.replace(/\s+/g, " "));
    const values = [...(rewrite?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(values).toEqual([...MOVE_REASON_CODES]);
    expect(MOVE_REASON_CODES.slice(-2)).toEqual(["AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION", "SOURCE_RELEASE_REJECTED"]);
  });

  it("every routed step is a registered task whose topic the definer derives as 'connections.move.' || step", () => {
    expect(MOVE_STEPS).toEqual(["release_source", "activate_destination", "reject_destination"]);
    for (const step of MOVE_STEPS) {
      expect(MOVE_TOPICS[step]).toBe(`connections.move.${step}`);
      expect(migration).toContain(`when '${step}' then`);
      expect(migration).toContain(`'${MOVE_TOPICS[step]}'`);
      expect(PRODUCTION_TASKS.tenant(MOVE_TOPICS[step])).toBeDefined();
    }
    expect(PRODUCTION_TASKS.tenant(CAPABILITY_EVALUATION_TOPIC)).toBeDefined();
    // The human retry is a fourth, LOCAL routing step onto the activation task (a new durable attempt).
    expect(migration).toContain(`when '${RETRY_ACTIVATION_STEP}' then`);
  });

  it("G6: web and worker can't append any saga topic; only the definer's owner policy admits them", () => {
    const flat = migration.replace(/\s+/g, " ");
    const restrictive = /create policy no_direct_move_routing on system\.outbox as restrictive for insert to authenticated, app_worker with check \(topic not in \(([^)]*)\)\);/.exec(flat);
    expect([...(restrictive?.[1] ?? "").matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]).sort()).toEqual(Object.values(MOVE_TOPICS).sort());
    expect(flat).toMatch(/create policy owner_move_route on system\.outbox for insert to app_owner /);
  });

  it("every audit step maps to its Move action in the definer and the owner audit policy", () => {
    const actions: Record<(typeof MOVE_AUDIT_STEPS)[number], string> = {
      moved_out: "connected_account.moved_out",
      moved_in: "connected_account.moved_in",
      move_failed: "connected_account.move_failed",
      move_rejected: "connected_account.move_rejected",
    };
    for (const step of MOVE_AUDIT_STEPS) {
      expect(migration).toContain(`when '${step}' then v_action := '${actions[step]}'`);
    }
    // move_requested is a web action attributed to the requesting user itself: never admitted by the owner policy.
    const policy = migration.slice(migration.indexOf("create policy owner_move_audit"), migration.indexOf("-- ── Definer functions"));
    expect(policy).not.toContain("move_requested");
    expect(policy).not.toContain("linked");
  });
});

describe("retry", () => {
  const move = (status: IncomingMove["status"]) => ({ status }) as IncomingMove;

  it("only a failed activation can be retried", () => {
    expect(isRetryable(move("ACTIVATION_FAILED"))).toBe(true);
    for (const status of ["REQUESTED", "COMPLETED", "REJECTED"] as const) expect(isRetryable(move(status))).toBe(false);
  });
});
