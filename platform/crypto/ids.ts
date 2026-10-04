/** UUID generation for internal identities (TA §18.1). */
export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}
