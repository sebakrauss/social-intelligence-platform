/**
 * Authentication boundary (TA §10.1–§10.2). Supabase Auth owns authentication; the application owns
 * authorization. These provider-neutral types are all the rest of the codebase sees: Supabase SDK
 * types never leave `platform/auth`.
 *
 * MFA: the shape doesn't block it (assurance level can be added to AuthUser), but mandatory MFA for
 * Owner/Admin is not enforced — TA-Q-10 is OPEN.
 */
import type { VerifiedEmail } from "@/domain/email";
import type { UserId } from "@/domain/ids";

/** A user whose session was validated server-side with the auth service on this request. */
export interface AuthUser {
  readonly id: UserId;
  /** Email verification is required before accessing any organization (TA §10.2). */
  readonly emailVerified: boolean;
  /**
   * The verified address, present only when `emailVerified`. Used server-side to bind invitations to
   * their recipient. Sensitive: never logged, audited, observed or returned in errors.
   */
  readonly verifiedEmail?: VerifiedEmail;
}

export type SignInOutcome = "signed_in" | "invalid_credentials" | "verification_required" | "rate_limited" | "unavailable";

/**
 * Sign-up outcomes. An address that already has an account reports "verification_required" like a new
 * one, so the form doesn't reveal which addresses are registered.
 */
export type SignUpOutcome = "verification_required" | "signed_in" | "weak_password" | "invalid_input" | "rate_limited" | "unavailable";

export type LinkRequestOutcome = "sent" | "rate_limited" | "unavailable";

export type CallbackOutcome = "signed_in" | "invalid_link" | "unavailable";

/** Email links handled by the callback route. */
export const EMAIL_LINK_TYPES = ["email", "magiclink", "signup", "invite"] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];

export type CallbackParams =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "token_hash"; readonly tokenHash: string; readonly type: EmailLinkType };

export interface AuthPort {
  /** Re-validates the session with the auth service. Never decodes an unverified token. */
  getVerifiedUser(): Promise<AuthUser | undefined>;
  signInWithPassword(email: string, password: string): Promise<SignInOutcome>;
  /** Registers an email/password account. The verification email links back to `redirectTo`. */
  signUpWithPassword(email: string, password: string, redirectTo: string): Promise<SignUpOutcome>;
  /** Sign-in link for an existing account. Doesn't create accounts. */
  requestSignInLink(email: string, redirectTo: string): Promise<LinkRequestOutcome>;
  completeEmailLink(params: CallbackParams): Promise<CallbackOutcome>;
  signOut(): Promise<void>;
}

/** Minimal identity contract the action pipeline needs. */
export type IdentityPort = Pick<AuthPort, "getVerifiedUser">;

/** Request/response cookie bridge supplied by the framework layer (server/auth). */
export interface CookieJar {
  getAll(): readonly { readonly name: string; readonly value: string }[];
  setAll(cookies: readonly { readonly name: string; readonly value: string; readonly options: Readonly<Record<string, unknown>> }[]): void;
}
