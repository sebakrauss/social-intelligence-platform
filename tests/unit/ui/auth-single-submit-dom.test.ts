// @vitest-environment happy-dom
/**
 * W12-AUTH-FIX-01 — the auth forms submit their Server Action at most once at a time (DEV, 2026-11-24: one sign-up
 * attempt produced two `signUp` calls; the second, ~2.4 s after the confirmation email, was rate-limited and its
 * redirect hid the "check your email" screen — W12-AUTH-DIAG-01).
 *
 * The REAL pages (app/sign-up, app/sign-in) and the REAL client guard run in React's client renderer on a DOM
 * (happy-dom) with real clicks and real form submission; only the Server Actions are synthetic, under the test's
 * control (a deferred promise per call), so nothing here can reach Supabase. The server half (outcome → redirect) runs
 * the real actions against a synthetic auth port.
 *
 * Submissions use click() and requestSubmit(button). Implicit submission (Enter in a field) is a submit event whose
 * submitter is the form's default button, i.e. requestSubmit(button); requestSubmit(button) also fires even when that
 * button is disabled, which is why the guard sits on the submit event and not only on the button. (happy-dom's
 * requestSubmit() WITHOUT a submitter breaks React's own FormData construction, so that form is not used here.)
 */
import { act, Component, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred { readonly promise: Promise<void>; resolve(): void; reject(error: Error): void }
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A synthetic Server Action: records each call's fields and stays pending until the test settles it. */
function syntheticAction() {
  const calls: { readonly fields: Record<string, string>; readonly settle: Deferred }[] = [];
  const action = vi.fn((form: FormData): Promise<void> => {
    const settle = deferred();
    calls.push({ fields: Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v.name])), settle });
    return settle.promise;
  });
  return { action, calls };
}

async function settle(run: () => void | Promise<void> = () => undefined): Promise<void> {
  await act(async () => {
    await run();
    await Promise.resolve();
  });
}

let container: HTMLElement;
let root: Root | undefined;
const actions = { signUp: syntheticAction(), signIn: syntheticAction(), link: syntheticAction(), signOut: syntheticAction() };

beforeEach(() => {
  vi.resetModules();
  actions.signUp = syntheticAction();
  actions.signIn = syntheticAction();
  actions.link = syntheticAction();
  actions.signOut = syntheticAction();
  vi.doMock("@/server/auth/actions", () => ({
    signUpWithPasswordAction: actions.signUp.action,
    signInWithPasswordAction: actions.signIn.action,
    requestSignInLinkAction: actions.link.action,
    signOutAction: actions.signOut.action,
  }));
  // next/link needs the App Router's context; a plain anchor is enough for these pages' one link.
  vi.doMock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => h("a", { href }, children) }));
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  // React entangles every in-flight async action globally: settle this test's pending ones before the next test runs.
  await settle(() => {
    for (const synthetic of Object.values(actions)) for (const call of synthetic.calls) call.settle.resolve();
  });
  await settle(() => {
    root?.unmount();
  });
  root = undefined;
  container.remove();
  vi.doUnmock("@/server/auth/actions");
  vi.doUnmock("next/link");
});

async function renderSignUp(status?: string): Promise<void> {
  const { default: SignUpPage } = await import("@/app/sign-up/page");
  const element = await SignUpPage({ searchParams: Promise.resolve(status === undefined ? {} : { status }) });
  if (root === undefined) root = createRoot(container);
  await settle(() => {
    root?.render(element);
  });
}

async function renderSignIn(status?: string): Promise<void> {
  const { default: SignInPage } = await import("@/app/sign-in/page");
  const element = await SignInPage({ searchParams: Promise.resolve(status === undefined ? {} : { status }) });
  if (root === undefined) root = createRoot(container);
  await settle(() => {
    root?.render(element);
  });
}

const formAt = (index: number): HTMLFormElement => {
  const form = container.querySelectorAll("form")[index];
  if (!(form instanceof HTMLFormElement)) throw new Error(`no form ${String(index)}`);
  return form;
};
const buttonOf = (form: HTMLFormElement): HTMLButtonElement => {
  const button = form.querySelector("button[type=submit]");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no submit button");
  return button;
};
const fill = (form: HTMLFormElement, values: Record<string, string>): void => {
  for (const [name, value] of Object.entries(values)) {
    const input = form.querySelector(`input[name=${name}]`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no input ${name}`);
    input.value = value;
  }
};
const SYNTHETIC = { email: "u1@example.test", password: "synthetic-password-1" };

describe("baseline: what the 8cd5115 markup allowed", () => {
  it("an unguarded <form action> invokes its action once per submit event while the first is still pending", async () => {
    const { action, calls } = syntheticAction();
    root = createRoot(container);
    await settle(() => {
      root?.render(h("form", { action }, h("button", { type: "submit" }, "Create account")));
    });
    const form = formAt(0);
    await settle(() => {
      buttonOf(form).click();
    });
    await settle(() => {
      form.requestSubmit(buttonOf(form));
    });
    await settle(() => {
      buttonOf(form).click();
    });
    // React dispatches every one of them; the App Router would queue the extras and post them after the first.
    expect(action).toHaveBeenCalledTimes(3);
    await settle(() => {
      for (const call of calls) call.settle.resolve();
    });
  });
});

describe("sign-up: one request per attempt", () => {
  it("1 / 7 — a valid submission calls the action exactly once with the typed fields and shows a visible pending state", async () => {
    await renderSignUp();
    const form = formAt(0);
    const button = buttonOf(form);
    expect(button.textContent).toBe("Create account");
    expect(button.disabled).toBe(false);
    fill(form, SYNTHETIC);
    await settle(() => {
      button.click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
    expect(actions.signUp.calls[0]?.fields).toEqual(SYNTHETIC);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toBe("Creating account…");
    // 7: the Server Action's own redirect (verification_required → /sign-in?status=sign_up_check_email) is untouched:
    // the form passes the action itself, not a wrapper (proven on the server side below).
  });

  it("2 — a rapid double click (same tick and next tick) sends one request", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    await settle(() => {
      buttonOf(form).click();
      buttonOf(form).click();
    });
    await settle(() => {
      buttonOf(form).click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
  });

  it("3 — Enter (implicit submission) followed by a click sends one request", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    const password = form.querySelector("input[name=password]");
    if (!(password instanceof HTMLInputElement)) throw new Error("no password input");
    // Implicit submission (Enter in a field) is a submit event whose submitter is the form's default button.
    await settle(() => {
      form.requestSubmit(buttonOf(form));
    });
    await settle(() => {
      password.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle(() => {
      buttonOf(form).click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
  });

  it("4 — concurrent submit events, including requestSubmit() that ignores a disabled button, send one request", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    await settle(() => {
      form.requestSubmit(buttonOf(form));
      form.requestSubmit(buttonOf(form));
      buttonOf(form).click();
      form.requestSubmit(buttonOf(form));
    });
    // The button is disabled now; requestSubmit(button) still fires a submit event — the guard, not the button, stops it.
    expect(buttonOf(form).disabled).toBe(true);
    await settle(() => {
      form.requestSubmit(buttonOf(form));
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
  });

  it("5 — a slow server: repeated attempts while pending send nothing more; once settled, a deliberate retry is allowed", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    await settle(() => {
      buttonOf(form).click();
    });
    for (let i = 0; i < 5; i += 1) {
      await settle(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      await settle(() => {
        form.requestSubmit(buttonOf(form));
      });
      await settle(() => {
        buttonOf(form).click();
      });
    }
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
    expect(buttonOf(form).disabled).toBe(true);
    // The first request returns (in the app: an error redirect re-rendering this page).
    await settle(() => {
      actions.signUp.calls[0]?.settle.resolve();
    });
    await settle();
    expect(buttonOf(form).disabled).toBe(false);
    expect(buttonOf(form).textContent).toBe("Create account");
    fill(form, SYNTHETIC);
    await settle(() => {
      buttonOf(form).click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(2);
  });

  it("6 — a genuine error is still shown and the form can be used again (the status message is the server's, unchanged)", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    await settle(() => {
      buttonOf(form).click();
    });
    await settle(() => {
      actions.signUp.calls[0]?.settle.resolve();
    });
    // The action redirected to /sign-up?status=rate_limited: the same page renders again with that status.
    await renderSignUp("rate_limited");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Too many attempts. Wait a moment and try again.");
    const again = formAt(0);
    expect(buttonOf(again).disabled).toBe(false);
    fill(again, SYNTHETIC);
    await settle(() => {
      buttonOf(again).click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(2);
  });

  it("a rejected action (e.g. a network failure) is not swallowed: it reaches the error boundary as before", async () => {
    class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override render(): ReactNode {
        return this.state.failed ? h("p", { id: "boundary" }, "error boundary") : this.props.children;
      }
    }
    const { default: SignUpPage } = await import("@/app/sign-up/page");
    const element = await SignUpPage({ searchParams: Promise.resolve({}) });
    root = createRoot(container, { onCaughtError: () => undefined });
    await settle(() => {
      root?.render(h(Boundary, null, element));
    });
    const form = formAt(0);
    fill(form, SYNTHETIC);
    await settle(() => {
      buttonOf(form).click();
    });
    await settle(() => {
      actions.signUp.calls[0]?.settle.reject(new Error("synthetic network failure"));
    });
    await settle();
    expect(container.querySelector("#boundary")?.textContent).toBe("error boundary");
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
  });

  it("a submit event someone else already cancelled sends nothing and does not lock the form", async () => {
    await renderSignUp();
    const form = formAt(0);
    fill(form, SYNTHETIC);
    const cancelOnce = (event: Event): void => {
      event.preventDefault();
      form.removeEventListener("submit", cancelOnce, true);
    };
    form.addEventListener("submit", cancelOnce, true);
    await settle(() => {
      buttonOf(form).click();
    });
    expect(actions.signUp.action).not.toHaveBeenCalled();
    expect(buttonOf(form).disabled).toBe(false);
    await settle(() => {
      buttonOf(form).click();
    });
    expect(actions.signUp.action).toHaveBeenCalledTimes(1);
  });
});

describe("8 — sign-in: same guard, no regression", () => {
  it("the password form signs in once per attempt with its fields; the link form is independent", async () => {
    await renderSignIn("sign_up_check_email");
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      (await import("@/server/i18n")).t("auth.status.sign_up_check_email"),
    );
    const password = formAt(0);
    const link = formAt(1);
    expect(buttonOf(password).textContent).toBe("Sign in");
    expect(buttonOf(link).textContent).toBe("Send link");
    fill(password, SYNTHETIC);
    await settle(() => {
      buttonOf(password).click();
      buttonOf(password).click();
      password.requestSubmit(buttonOf(password));
    });
    expect(actions.signIn.action).toHaveBeenCalledTimes(1);
    expect(actions.signIn.calls[0]?.fields).toEqual(SYNTHETIC);
    expect(buttonOf(password).textContent).toBe("Signing in…");
    // The other form is not blocked by the first one's submission.
    expect(buttonOf(link).disabled).toBe(false);
    fill(link, { email: SYNTHETIC.email });
    await settle(() => {
      buttonOf(link).click();
      buttonOf(link).click();
    });
    expect(actions.link.action).toHaveBeenCalledTimes(1);
    expect(actions.link.calls[0]?.fields).toEqual({ email: SYNTHETIC.email });
    expect(buttonOf(link).textContent).toBe("Sending link…");
    expect(actions.signUp.action).not.toHaveBeenCalled();
  });

  it("an invalid form (required field empty) is not submitted and does not lock the form", async () => {
    await renderSignIn();
    const password = formAt(0);
    await settle(() => {
      buttonOf(password).click();
    });
    expect(actions.signIn.action).not.toHaveBeenCalled();
    fill(password, SYNTHETIC);
    await settle(() => {
      buttonOf(password).click();
    });
    expect(actions.signIn.action).toHaveBeenCalledTimes(1);
  });
});

describe("server side: the actions' outcomes and redirects are unchanged (synthetic auth port, nothing reaches Supabase)", () => {
  type Outcome = "verification_required" | "signed_in" | "weak_password" | "invalid_input" | "rate_limited" | "unavailable" | "invalid_credentials";
  async function runAction(name: "signUpWithPasswordAction" | "signInWithPasswordAction", outcome: Outcome): Promise<{ redirect: string; calls: number }> {
    vi.resetModules();
    vi.doUnmock("@/server/auth/actions");
    let calls = 0;
    const port = {
      signUpWithPassword: vi.fn(() => { calls += 1; return Promise.resolve(outcome); }),
      signInWithPassword: vi.fn(() => { calls += 1; return Promise.resolve(outcome); }),
    };
    vi.doMock("@/server/auth/request-auth", () => ({ requestAuth: () => Promise.resolve(port) }));
    vi.doMock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
    const previous = process.env["APP_BASE_URL"];
    process.env["APP_BASE_URL"] = "https://example.test";
    try {
      const module = await import("@/server/auth/actions");
      const form = new FormData();
      form.set("email", SYNTHETIC.email);
      form.set("password", SYNTHETIC.password);
      try {
        await module[name](form);
      } catch (error) {
        return { redirect: error instanceof Error ? error.message : "?", calls };
      }
      return { redirect: "none", calls };
    } finally {
      if (previous === undefined) delete process.env["APP_BASE_URL"];
      else process.env["APP_BASE_URL"] = previous;
      vi.doUnmock("@/server/auth/request-auth");
      vi.doUnmock("next/navigation");
    }
  }

  it("7 — sign-up success still lands on the confirmation screen; genuine errors still reach the page (one provider call each)", async () => {
    expect(await runAction("signUpWithPasswordAction", "verification_required")).toEqual({ redirect: "REDIRECT /sign-in?status=sign_up_check_email", calls: 1 });
    expect(await runAction("signUpWithPasswordAction", "signed_in")).toEqual({ redirect: "REDIRECT /", calls: 1 });
    expect(await runAction("signUpWithPasswordAction", "rate_limited")).toEqual({ redirect: "REDIRECT /sign-up?status=rate_limited", calls: 1 });
    expect(await runAction("signUpWithPasswordAction", "weak_password")).toEqual({ redirect: "REDIRECT /sign-up?status=weak_password", calls: 1 });
    expect(await runAction("signUpWithPasswordAction", "unavailable")).toEqual({ redirect: "REDIRECT /sign-up?status=unavailable", calls: 1 });
  });

  it("8 — sign-in outcomes are unchanged", async () => {
    expect(await runAction("signInWithPasswordAction", "signed_in")).toEqual({ redirect: "REDIRECT /", calls: 1 });
    expect(await runAction("signInWithPasswordAction", "invalid_credentials")).toEqual({ redirect: "REDIRECT /sign-in?status=invalid_credentials", calls: 1 });
    expect(await runAction("signInWithPasswordAction", "rate_limited")).toEqual({ redirect: "REDIRECT /sign-in?status=rate_limited", calls: 1 });
  });
});
