/**
 * W12-LOG-HARDEN-03 F-1/F-5: the pipeline lets a thrown value through unsanitized as a Next.js control-flow signal
 * ONLY if Next 16.4.5 itself both (a) recognizes it (`unstable_rethrow`, public API) and (b) consumes it without
 * printing it (`getDigestForWellKnownError`, the server error handler's exemption list). Checked here against Next's
 * own functions, not against a transcription. These framework imports exist in this test only: if a Next upgrade
 * moves or changes them, this test fails and the replicated predicates must be re-checked.
 */
import { getDigestForWellKnownError } from "next/dist/server/app-render/create-error-handler";
import { DynamicServerError } from "next/dist/client/components/hooks-server-context";
import { BailoutToCSRError } from "next/dist/shared/lib/lazy-dynamic/bailout-to-csr";
import { RedirectType, notFound, permanentRedirect, redirect, unstable_rethrow } from "next/navigation";
import { describe, expect, it } from "vitest";
import { isFrameworkControlFlow } from "@/server/pipeline/pipeline";

/** Whether Next's unstable_rethrow recognizes the value ITSELF (not a control error nested in its cause). */
function nextRecognizes(value: unknown): boolean {
  try {
    unstable_rethrow(value);
    return false;
  } catch (rethrown) {
    return rethrown === value;
  }
}

/** Whether Next's server error handler would consume the value without printing it. */
function nextDoesNotPrint(value: unknown): boolean {
  return getDigestForWellKnownError(value) !== undefined;
}

function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const SENSITIVE = ["synthetic.viewer", "example.test"].join("@");
const withDigest = (digest: string, message = SENSITIVE): Error => Object.assign(new Error(message), { digest });

/** Signals exactly as Next creates them. */
const GENUINE: readonly (readonly [string, unknown])[] = [
  ["redirect (replace, 307)", thrownBy(() => redirect("/onboarding"))],
  ["redirect (push, 307)", thrownBy(() => redirect("/onboarding", RedirectType.push))],
  ["permanentRedirect (308)", thrownBy(() => permanentRedirect("/onboarding"))],
  ["notFound (404)", thrownBy(() => notFound())],
  // forbidden() / unauthorized() need Next's experimental authInterrupts; this is the error they throw when enabled.
  ["forbidden (403)", withDigest("NEXT_HTTP_ERROR_FALLBACK;403", "NEXT_HTTP_ERROR_FALLBACK;403")],
  ["unauthorized (401)", withDigest("NEXT_HTTP_ERROR_FALLBACK;401", "NEXT_HTTP_ERROR_FALLBACK;401")],
  ["dynamic usage", new DynamicServerError("cookies")],
  ["CSR bailout", new BailoutToCSRError("useSearchParams")],
  // createPrerenderInterruptedError (app-render/dynamic-rendering.js): an Error with this digest.
  ["prerender interrupted", withDigest("NEXT_PRERENDER_INTERRUPTED", "Route needs to bail out of prerendering")],
];

/** Look-alikes, malformed and forged values: none may pass through. */
const REJECTED: readonly (readonly [string, unknown])[] = [
  ["redirect, malformed", withDigest("NEXT_REDIRECT;x")],
  ["redirect, bad type", withDigest("NEXT_REDIRECT;jump;/x;307;")],
  ["redirect, bad status", withDigest("NEXT_REDIRECT;replace;/x;302;")],
  ["redirect, no status", withDigest("NEXT_REDIRECT;replace;/x")],
  ["fallback 500", withDigest("NEXT_HTTP_ERROR_FALLBACK;500")],
  ["fallback without status", withDigest("NEXT_HTTP_ERROR_FALLBACK")],
  ["hanging promise rejection (Next prints it)", withDigest("HANGING_PROMISE_REJECTION")],
  ["client hook dynamic (not a rethrow signal)", withDigest("CLIENT_HOOK_DYNAMIC")],
  ["plain object: prerender interrupted", { digest: "NEXT_PRERENDER_INTERRUPTED", message: SENSITIVE }],
  ["plain object: valid redirect", { digest: "NEXT_REDIRECT;replace;/x;307;", message: SENSITIVE }],
  ["plain object: dynamic usage", { digest: "DYNAMIC_SERVER_USAGE", message: SENSITIVE }],
  ["react postpone marker", { $$typeof: Symbol.for("react.postpone"), message: SENSITIVE }],
  ["unknown digest", withDigest("SOMETHING_ELSE")],
  ["numeric digest", Object.assign(new Error(SENSITIVE), { digest: 404 })],
  ["accessor digest", Object.defineProperty(new Error(SENSITIVE), "digest", { get: () => "NEXT_HTTP_ERROR_FALLBACK;404" })],
  ["throwing digest getter", Object.defineProperty(new Error(SENSITIVE), "digest", { get: () => { throw new Error(SENSITIVE); } })],
  ["proxy over a valid redirect", new Proxy(withDigest("NEXT_REDIRECT;replace;/x;307;"), {})],
  ["wrapper whose cause is a valid redirect", new Error(SENSITIVE, { cause: withDigest("NEXT_REDIRECT;replace;/x;307;") })],
  ["string", "NEXT_REDIRECT;replace;/x;307;"],
  ["null", null],
];

describe("Next.js control-flow recognition (parity with Next 16.4.5)", () => {
  it.each(GENUINE)("passes a genuine signal through: %s", (_label, value) => {
    expect(nextRecognizes(value)).toBe(true);
    expect(nextDoesNotPrint(value)).toBe(true);
    expect(isFrameworkControlFlow(value)).toBe(true);
  });

  it.each(REJECTED)("sanitizes a look-alike: %s", (_label, value) => {
    expect(isFrameworkControlFlow(value)).toBe(false);
  });

  it("never passes a value Next would not consume silently (no bypass), over genuine, rejected and generated digests", () => {
    const generated: unknown[] = [];
    for (const head of ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING", "NEXT_PRERENDER_INTERRUPTED", "HANGING_PROMISE_REJECTION", "next_redirect", ""]) {
      for (const middle of ["", "replace", "push", "jump", "404", "403", "401", "500", " 404", "0404", "4.04e2"]) {
        for (const tail of ["", "/x", "/a;b", ";"]) {
          for (const status of ["", "303", "307", "308", "302", "3.07e2", "NaN", "Infinity", "-0"]) {
            generated.push(withDigest([head, middle, tail, status, ""].join(";")));
            generated.push(withDigest(`${head};${middle}`));
          }
        }
      }
      generated.push(withDigest(head));
    }
    let passed = 0;
    for (const value of [...GENUINE.map(([, v]) => v), ...REJECTED.map(([, v]) => v), ...generated]) {
      if (isFrameworkControlFlow(value)) {
        passed += 1;
        expect(nextRecognizes(value)).toBe(true);
        expect(nextDoesNotPrint(value)).toBe(true);
      }
    }
    expect(passed).toBeGreaterThan(GENUINE.length);
  });

  it("matches Next exactly for Error instances with own data digests, except the documented stricter case", () => {
    const heads = ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING", "NEXT_PRERENDER_INTERRUPTED", "X"];
    for (const head of heads) {
      for (const middle of ["replace", "push", "404", "403", "401", "500", "jump"]) {
        for (const status of ["303", "307", "308", "302", "0404", ""]) {
          for (const digest of [`${head};${middle};/d;${status};`, `${head};${middle}`, head]) {
            const value = withDigest(digest);
            expect(isFrameworkControlFlow(value), digest).toBe(nextRecognizes(value) && nextDoesNotPrint(value));
          }
        }
      }
    }
    // The one deliberate difference: Next recognizes a hanging-promise rejection but prints it; it is sanitized here.
    const hanging = withDigest("HANGING_PROMISE_REJECTION");
    expect(nextRecognizes(hanging)).toBe(true);
    expect(nextDoesNotPrint(hanging)).toBe(false);
    expect(isFrameworkControlFlow(hanging)).toBe(false);
  });
});
