/**
 * Test recorder. Every case has an expected outcome ("ok" or an error name). Any deviation — above all an
 * unexpected permission success — stops the validation immediately (after an optional revert of a
 * destructive side effect). Measurements (R6) record the observed behavior without a verdict.
 * Every KMS call is logged by role and operation (outcome only) for the CloudTrail coverage check.
 */
import { describeError, log } from "./guard.mjs";

export class StopValidation extends Error {
  constructor(message) {
    super(message);
    this.name = "StopValidation";
  }
}

export class Recorder {
  /** `collect: true` records failed assertions without stopping (read-only reconciliation only). */
  constructor(runId, { collect = false } = {}) {
    this.runId = runId;
    this.collect = collect;
    this.cases = [];
    this.calls = [];
  }

  /** Sends one KMS command as `role` and records its outcome (never its payload). */
  async kms(role, client, Command, input) {
    const op = Command.name.replace(/Command$/, "");
    try {
      const output = await client.send(new Command(input));
      this.calls.push({ role, op, outcome: "ok", at: new Date().toISOString() });
      return output;
    } catch (error) {
      this.calls.push({ role, op, outcome: error?.name ?? "Error", at: new Date().toISOString() });
      throw error;
    }
  }

  async expect(id, title, run, expected, { onUnexpectedSuccess } = {}) {
    let observed;
    let value;
    try {
      value = await run();
      observed = "ok";
    } catch (error) {
      if (error instanceof StopValidation) throw error;
      observed = error?.name ?? "Error";
      if (observed === "Error") observed = describeError(error);
    }
    const pass = observed === expected;
    this.cases.push({ id, title, expected, observed, result: pass ? "PASS" : "FAIL" });
    log(`[${id}] ${pass ? "PASS" : "FAIL"} — ${title} (expected ${expected}, observed ${observed})`);
    if (!pass) {
      if (expected !== "ok" && observed === "ok" && onUnexpectedSuccess) {
        log(`[${id}] UNEXPECTED PERMISSION SUCCESS — reverting side effect, then stopping`);
        await onUnexpectedSuccess();
      }
      throw new StopValidation(`${id}: expected ${expected}, observed ${observed}`);
    }
    return value;
  }

  assert(id, title, condition) {
    const pass = condition === true;
    this.cases.push({ id, title, expected: "true", observed: String(condition), result: pass ? "PASS" : "FAIL" });
    log(`[${id}] ${pass ? "PASS" : "FAIL"} — ${title}`);
    if (!pass && !this.collect) throw new StopValidation(`${id}: assertion failed`);
  }

  async measure(id, title, run) {
    let observed;
    let value;
    try {
      value = await run();
      observed = "ok";
    } catch (error) {
      if (error instanceof StopValidation) throw error;
      observed = error?.name ?? "Error";
    }
    this.cases.push({ id, title, expected: "measure", observed, result: "MEASURED" });
    log(`[${id}] MEASURED — ${title} (observed ${observed})`);
    return { observed, value };
  }

  summary() {
    const count = (result) => this.cases.filter((c) => c.result === result).length;
    return { pass: count("PASS"), fail: count("FAIL"), measured: count("MEASURED"), total: this.cases.length };
  }
}
