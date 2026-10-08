/**
 * The source release a running job belongs to (Step 7E.4B.3; version-skew protection across execution planes).
 *
 * Both planes are deployed from the same source commit, each deployment carrying the same external deployment id
 * (`trigger deploy --external-id <commit SHA>`). A job running in release X pins every run it triggers in the OTHER plane
 * to that plane's deployment X, so a cross-plane trigger can never reach an unrelated version: Trigger.dev waits while
 * deployment X builds and expires the run if X never arrives (surfaced by R7 as a failed delivery).
 *
 *   pinned        a deployed run whose deployment carries an external id: cross-plane triggers are pinned to it
 *   development   a local development run (no deployments exist to pin to): triggers are unpinned
 *   unidentified  a deployed run WITHOUT an external id: cross-plane triggers are refused (fail closed)
 */
export type JobRelease =
  | { readonly kind: "pinned"; readonly releaseId: string }
  | { readonly kind: "development" }
  | { readonly kind: "unidentified" };

/** External deployment ids are opaque, at most 128 characters (Trigger.dev contract); whitespace is never valid. */
const RELEASE_ID = /^[^\s]{1,128}$/;

export function jobRelease(input: { readonly environmentType: string | undefined; readonly externalDeploymentId: string | undefined }): JobRelease {
  if (input.environmentType === "DEVELOPMENT") return { kind: "development" };
  const id = input.externalDeploymentId;
  return id !== undefined && RELEASE_ID.test(id) ? { kind: "pinned", releaseId: id } : { kind: "unidentified" };
}

/** Pin for a trigger into ANOTHER plane: the release id, nothing (development), or refused (unidentified). */
export function crossPlanePin(release: JobRelease): { readonly allowed: true; readonly externalDeploymentId: string | undefined } | { readonly allowed: false } {
  switch (release.kind) {
    case "pinned":
      return { allowed: true, externalDeploymentId: release.releaseId };
    case "development":
      return { allowed: true, externalDeploymentId: undefined };
    case "unidentified":
      return { allowed: false };
  }
}

/** Pin for a trigger into the job's OWN plane: the release id when known (same release), otherwise none. */
export function samePlanePin(release: JobRelease): string | undefined {
  return release.kind === "pinned" ? release.releaseId : undefined;
}
