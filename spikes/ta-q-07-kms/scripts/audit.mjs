/**
 * A — CloudTrail evidence from Event history (no trail is created). Only this run's runtime-role sessions
 * are considered. Raw events stay in memory; the evidence keeps event name, role, outcome, key slot and the
 * encryption-context keys with a value CLASS (constant / run UUID / declared negative literal / OTHER) —
 * never IP addresses, access-key IDs, user agents or raw payloads.
 */
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CONTEXT_CONSTANTS, CONTEXT_KEYS, NEGATIVE_LITERALS, REGION, SESSION_PREFIX } from "../lib/config.mjs";
import { log } from "../lib/guard.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NEGATIVE_VALUES = new Set(Object.values(NEGATIVE_LITERALS));

function classify(key, value) {
  if (Object.hasOwn(CONTEXT_CONSTANTS, key) && CONTEXT_CONSTANTS[key] === value) return "constant";
  if ((key === "workspace_id" || key === "credential_id") && UUID.test(value)) return "run-uuid";
  if (NEGATIVE_VALUES.has(value) || NEGATIVE_VALUES.has(key)) return "declared-negative-literal";
  return "OTHER";
}

function contexts(requestParameters) {
  const found = [];
  for (const [name, value] of Object.entries(requestParameters ?? {})) {
    if (/encryptioncontext$/i.test(name) && value && typeof value === "object") found.push([name, value]);
  }
  return found;
}

async function lookup(ct, startTime) {
  const events = [];
  for (let token; ;) {
    const page = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: "EventSource", AttributeValue: "kms.amazonaws.com" }],
        StartTime: startTime,
        EndTime: new Date(),
        MaxResults: 50,
        NextToken: token,
      }),
    );
    events.push(...(page.Events ?? []));
    token = page.NextToken;
    if (!token) break;
    await sleep(600); // LookupEvents allows 2 requests per second
  }
  return events;
}

export async function audit({ operator, manifest, keyArns, maxWaitMinutes = 30, firstWaitMinutes = 5, deadline }) {
  const ct = new CloudTrailClient({ region: REGION, credentials: operator });
  const startTime = new Date(Date.parse(manifest.startedAt) - 120_000);
  const sessionMarker = `${SESSION_PREFIX}-`;
  const runMarker = `-${manifest.runId}`;
  const slotOf = (keyId) => Object.entries(keyArns).find(([, arn]) => keyId && (arn === keyId || arn.endsWith(`/${keyId}`)))?.[0] ?? "unknown";

  const expectedOk = new Map();
  for (const c of manifest.calls) if (c.outcome === "ok") expectedOk.set(`${c.role}|${c.op}`, (expectedOk.get(`${c.role}|${c.op}`) ?? 0) + 1);
  const attemptedDenied = manifest.calls.filter((c) => c.outcome === "AccessDeniedException").length;

  log(`[audit] waiting ${String(firstWaitMinutes)} minutes for CloudTrail Event history delivery`);
  await sleep(firstWaitMinutes * 60_000);
  const stopAt = Math.min(Date.now() + maxWaitMinutes * 60_000, deadline ?? Number.POSITIVE_INFINITY);

  let summarized = [];
  let coverage = null;
  for (;;) {
    const raw = await lookup(ct, startTime);
    summarized = [];
    for (const event of raw) {
      const detail = JSON.parse(event.CloudTrailEvent ?? "{}");
      const sessionArn = detail.userIdentity?.arn ?? "";
      const session = sessionArn.split("/").pop() ?? "";
      if (!session.startsWith(sessionMarker) || !session.endsWith(runMarker)) continue;
      const role = session.slice(sessionMarker.length, session.length - runMarker.length);
      const ctxs = contexts(detail.requestParameters).map(([field, value]) => ({
        field,
        keys: Object.keys(value).sort(),
        classes: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, classify(k, String(v))])),
      }));
      const parameterNames = Object.keys(detail.requestParameters ?? {}).sort();
      summarized.push({
        eventTime: detail.eventTime,
        eventName: detail.eventName,
        role,
        errorCode: detail.errorCode ?? null,
        keySlot: slotOf(detail.requestParameters?.keyId ?? detail.requestParameters?.destinationKeyId),
        contexts: ctxs,
        requestParameterNames: parameterNames,
        plaintextFieldLogged: [...parameterNames, ...Object.keys(detail.responseElements ?? {})].some((n) => /plaintext/i.test(n)),
      });
    }
    const observedOk = new Map();
    for (const e of summarized) if (!e.errorCode) observedOk.set(`${e.role}|${e.eventName}`, (observedOk.get(`${e.role}|${e.eventName}`) ?? 0) + 1);
    const missing = [...expectedOk].filter(([key, n]) => (observedOk.get(key) ?? 0) < n).map(([key, n]) => ({ key, expected: n, observed: observedOk.get(key) ?? 0 }));
    coverage = { expectedOkCalls: [...expectedOk.values()].reduce((a, b) => a + b, 0), missing };
    log(`[audit] events for this run: ${String(summarized.length)}; successful calls not yet visible: ${String(missing.reduce((a, m) => a + m.expected - m.observed, 0))}`);
    if (missing.length === 0 || Date.now() + 120_000 > stopAt) break;
    await sleep(120_000);
  }

  const contextFindings = summarized.flatMap((e) => e.contexts.flatMap((c) => Object.entries(c.classes).filter(([, cls]) => cls === "OTHER").map(([k]) => ({ eventName: e.eventName, field: c.field, key: k }))));
  const unexpectedKeys = summarized.flatMap((e) =>
    e.contexts.flatMap((c) => c.keys.filter((k) => !CONTEXT_KEYS.includes(k) && k !== NEGATIVE_LITERALS.extraKey).map((k) => ({ eventName: e.eventName, key: k }))),
  );
  return {
    events: summarized,
    coverage,
    deniedAttempted: attemptedDenied,
    deniedLogged: summarized.filter((e) => e.errorCode === "AccessDenied" || e.errorCode === "AccessDeniedException").length,
    contextFindings,
    unexpectedKeys,
    plaintextFieldsLogged: summarized.filter((e) => e.plaintextFieldLogged).length,
  };
}
