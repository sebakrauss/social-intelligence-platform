/**
 * Step H7-credential-context-code-readiness — the `prod` cryptographic environment, offline. Synthetic keys, ARNs,
 * contexts and PUBLIC synthetic certificates (fixtures/aws-identity, trusted by nothing); in-process KMS doubles; no
 * AWS request, no Roles Anywhere session, no provider. Proves: a prod envelope opens only under prod; dev ↔ prod,
 * workspace, credential and tampered contexts are refused; keyring selection, configuration, identity (CN ↔ label) and
 * plane allowlists fail closed; errors are normalized and leak nothing.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { KMS_CONTEXT_ENVS, KMS_PROVIDER_CREDENTIALS_KEY_REF, parseKmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import { createKmsClient } from "@/platform/crypto/credentials/aws-kms-client";
import { createKmsDataKeyGenerator, type KmsGenerateDataKeySender } from "@/platform/crypto/credentials/aws-kms-generator";
import { createKmsDataKeyUnwrapper, type KmsDecryptSender } from "@/platform/crypto/credentials/aws-kms-unwrapper";
import { CREDENTIAL_CONTEXT_ENVS, canonicalContextBytes, credentialContext, parseCredentialContext, type CredentialContext } from "@/platform/crypto/credentials/context";
import { CredentialCryptoError, isRetryableCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { createLocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { PLANE_FORBIDDEN_VARIABLES } from "@/jobs/plane-environment";
import { credentialEnvironmentLabel, readKmsKeyringConfig, selectCredentialCrypto } from "@/server/connections/environment";
import { codeOf } from "../../support/source-scan";

const root = path.resolve(import.meta.dirname, "../../..");

const ACCOUNT_DEV = "000000000000";
const ACCOUNT_PROD = "111111111111";
const KEY_DEV = `arn:aws:kms:sa-east-1:${ACCOUNT_DEV}:key/00000000-0000-4000-8000-0000000000aa`;
const KEY_PROD = `arn:aws:kms:sa-east-1:${ACCOUNT_PROD}:key/00000000-0000-4000-8000-0000000000bb`;
const KEY_PROD_OTHER_REGION = `arn:aws:kms:us-east-1:${ACCOUNT_PROD}:key/00000000-0000-4000-8000-0000000000cc`;
const WORKSPACE = randomUUID();
const CREDENTIAL = randomUUID();
const MARKER = `SIP-SYNTHETIC-PROD-CREDENTIAL-${randomUUID()}`;
const marker = (): Uint8Array => new Uint8Array(Buffer.from(MARKER, "utf8"));
const ctx = (overrides: Partial<{ env: string; workspaceId: string; credentialId: string }> = {}): CredentialContext =>
  credentialContext({ purpose: "provider-credential", env: overrides.env ?? "prod", workspaceId: overrides.workspaceId ?? WORKSPACE, credentialId: overrides.credentialId ?? CREDENTIAL });

const codeOfFailure = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CredentialCryptoError);
  return (error as CredentialCryptoError).code;
};
const syncCode = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCryptoError);
    return (error as CredentialCryptoError).code;
  }
  throw new Error("expected a CredentialCryptoError");
};

/**
 * An in-process KMS double with ONE key per environment. Each key's wrap is authenticated with the encryption context
 * (as KMS does): a blob decrypts only under its own key AND the exact context it was wrapped with. The double enforces
 * the production key policies offline: the dev key accepts only `env=dev` requests, the prod key only `env=prod`.
 */
type GenerateCommand = Parameters<KmsGenerateDataKeySender["send"]>[0];
type GenerateOutput = Awaited<ReturnType<KmsGenerateDataKeySender["send"]>>;
type DecryptCommandLike = Parameters<KmsDecryptSender["send"]>[0];
type DecryptOutput = Awaited<ReturnType<KmsDecryptSender["send"]>>;
function kmsDouble() {
  const keys = new Map<string, { kek: Buffer; env: string }>([[KEY_DEV, { kek: randomBytes(32), env: "dev" }], [KEY_PROD, { kek: randomBytes(32), env: "prod" }]]);
  const sent: { readonly kind: "generate" | "decrypt"; readonly input: Record<string, unknown> }[] = [];
  const aad = (context: Record<string, string>): Buffer => Buffer.from(JSON.stringify(Object.entries(context).sort()), "utf8");
  const wrap = (keyArn: string, dek: Buffer, context: Record<string, string>): Uint8Array => {
    const key = keys.get(keyArn);
    if (key === undefined) throw Object.assign(new Error("synthetic"), { name: "NotFoundException" });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.kek, iv);
    cipher.setAAD(aad(context));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return new Uint8Array(Buffer.concat([Buffer.from(keyArn.slice(-12), "utf8"), iv, cipher.getAuthTag(), body]));
  };
  const policyDenied = (keyArn: string, context: Record<string, string>): boolean => keys.get(keyArn)?.env !== context["env"];
  const generate = {
    send(command: GenerateCommand): Promise<GenerateOutput> {
      sent.push({ kind: "generate", input: { ...command.input } });
      const keyArn = command.input.KeyId ?? "";
      const context = command.input.EncryptionContext ?? {};
      if (policyDenied(keyArn, context)) return Promise.reject(Object.assign(new Error("synthetic"), { name: "AccessDeniedException" }));
      const dek = randomBytes(32);
      return Promise.resolve({ KeyId: keyArn, Plaintext: new Uint8Array(dek), CiphertextBlob: wrap(keyArn, dek, context), $metadata: {} });
    },
  };
  const decrypt = {
    send(command: DecryptCommandLike): Promise<DecryptOutput> {
      sent.push({ kind: "decrypt", input: { ...command.input } });
      const blob = Buffer.from(command.input.CiphertextBlob ?? new Uint8Array());
      const suffix = blob.subarray(0, 12).toString("utf8");
      const keyArn = [...keys.keys()].find((arn) => arn.endsWith(suffix));
      const context = command.input.EncryptionContext ?? {};
      if (keyArn === undefined) return Promise.reject(Object.assign(new Error("synthetic"), { name: "InvalidCiphertextException" }));
      if (policyDenied(keyArn, context)) return Promise.reject(Object.assign(new Error("synthetic"), { name: "AccessDeniedException" }));
      const key = keys.get(keyArn);
      if (key === undefined) return Promise.reject(Object.assign(new Error("synthetic"), { name: "NotFoundException" }));
      try {
        const decipher = createDecipheriv("aes-256-gcm", key.kek, blob.subarray(12, 24));
        decipher.setAAD(aad(context));
        decipher.setAuthTag(blob.subarray(24, 40));
        const dek = Buffer.concat([decipher.update(blob.subarray(40)), decipher.final()]);
        return Promise.resolve({ KeyId: keyArn, Plaintext: new Uint8Array(dek), EncryptionAlgorithm: "SYMMETRIC_DEFAULT", $metadata: {} });
      } catch {
        return Promise.reject(Object.assign(new Error("synthetic"), { name: "InvalidCiphertextException" }));
      }
    },
  };
  return { generate, decrypt, sent };
}
const sealerFor = (kms: ReturnType<typeof kmsDouble>, keyArn: string) => createCredentialSealer(createKmsDataKeyGenerator(kms.generate, { keyRef: KMS_PROVIDER_CREDENTIALS_KEY_REF, currentKeyArn: keyArn }));
const openerFor = (kms: ReturnType<typeof kmsDouble>, allowed: readonly string[]) => createCredentialOpener(createKmsDataKeyUnwrapper(kms.decrypt, { keyRef: KMS_PROVIDER_CREDENTIALS_KEY_REF, allowedKeyArns: [...allowed] }));
const read = (p: Uint8Array): string => Buffer.from(p).toString("utf8");

describe("1. the prod label is a first-class cryptographic environment, distinct from every other", () => {
  it("prod is in both closed sets; the deployment tier name 'production' is in neither", () => {
    expect([...CREDENTIAL_CONTEXT_ENVS]).toEqual(["local", "test", "dev", "prod"]);
    expect([...KMS_CONTEXT_ENVS]).toEqual(["dev", "prod"]);
    for (const env of ["production", "staging", "preview", "Prod", "PROD"]) expect(syncCode(() => ctx({ env }))).toBe("INVALID_CONTEXT");
    expect(parseCredentialContext(ctx()).env).toBe("prod");
    expect(canonicalContextBytes(ctx()).toString("utf8")).toContain('["env","prod"]');
  });

  it("KMS configuration accepts prod and refuses local, test and the tier names; the region comes from the prod key ARN", () => {
    const config = parseKmsKeyringConfig({ contextEnv: "prod", currentKeyArn: KEY_PROD, allowedKeyArns: KEY_PROD });
    expect(config).toMatchObject({ contextEnv: "prod", region: "sa-east-1", currentKeyArn: KEY_PROD, logicalKeyRef: KMS_PROVIDER_CREDENTIALS_KEY_REF });
    for (const contextEnv of ["local", "test", "production", "staging", "", undefined]) {
      expect(syncCode(() => parseKmsKeyringConfig({ contextEnv, currentKeyArn: KEY_PROD, allowedKeyArns: KEY_PROD })), String(contextEnv)).toBe("KEYRING_MISCONFIGURED");
    }
    // Region or ARN incompatibilities: an allowed key in another region, a current key not in the allowlist, an alias.
    expect(syncCode(() => parseKmsKeyringConfig({ contextEnv: "prod", currentKeyArn: KEY_PROD, allowedKeyArns: `${KEY_PROD},${KEY_PROD_OTHER_REGION}` }))).toBe("KEYRING_MISCONFIGURED");
    expect(syncCode(() => parseKmsKeyringConfig({ contextEnv: "prod", currentKeyArn: KEY_PROD, allowedKeyArns: KEY_DEV }))).toBe("KEYRING_MISCONFIGURED");
    expect(syncCode(() => parseKmsKeyringConfig({ contextEnv: "prod", currentKeyArn: "alias/prod", allowedKeyArns: "alias/prod" }))).toBe("KEYRING_MISCONFIGURED");
  });
});

describe("2. seal and open under prod; every cross-environment or cross-tenant opening is refused", () => {
  it("a credential sealed under prod opens under prod — through the KMS double and through the local keyring", async () => {
    const kms = kmsDouble();
    const envelope = await sealerFor(kms, KEY_PROD).seal(marker(), ctx());
    expect(envelope.keyRef).toBe(KMS_PROVIDER_CREDENTIALS_KEY_REF);
    expect(await openerFor(kms, [KEY_PROD]).open(envelope, ctx(), read)).toBe(MARKER);
    const decryptInput = kms.sent.at(-1);
    expect(decryptInput?.kind).toBe("decrypt");
    expect(decryptInput?.input["EncryptionContext"]).toEqual({ app: "social-intelligence-platform", purpose: "provider-credential", env: "prod", v: "1", workspace_id: WORKSPACE, credential_id: CREDENTIAL });
    expect("KeyId" in (decryptInput?.input ?? {})).toBe(false);

    const key = randomBytes(32);
    const local = createLocalKeyring(key, { NODE_ENV: "test" });
    key.fill(0);
    const localEnvelope = await createCredentialSealer(local.generator).seal(marker(), ctx());
    expect(await createCredentialOpener(local.unwrapper).open(localEnvelope, ctx(), read)).toBe(MARKER);
  });

  it("prod envelope + dev context → REFUSED; dev envelope + prod context → REFUSED (AAD and key policy both refuse)", async () => {
    const kms = kmsDouble();
    const prodEnvelope = await sealerFor(kms, KEY_PROD).seal(marker(), ctx({ env: "prod" }));
    const devEnvelope = await sealerFor(kms, KEY_DEV).seal(marker(), ctx({ env: "dev" }));
    // A prod runtime (prod allowlist) handed a dev envelope, and a dev runtime handed a prod envelope.
    expect(await codeOfFailure(openerFor(kms, [KEY_PROD]).open(devEnvelope, ctx({ env: "prod" }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED|KEYRING_MISCONFIGURED)$/);
    expect(await codeOfFailure(openerFor(kms, [KEY_DEV]).open(prodEnvelope, ctx({ env: "dev" }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED|KEYRING_MISCONFIGURED)$/);
    // Even a runtime that (wrongly) allows BOTH keys cannot open across labels: the label is in the AAD and in the context.
    expect(await codeOfFailure(openerFor(kms, [KEY_DEV, KEY_PROD]).open(devEnvelope, ctx({ env: "prod" }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED)$/);
    expect(await codeOfFailure(openerFor(kms, [KEY_DEV, KEY_PROD]).open(prodEnvelope, ctx({ env: "dev" }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED)$/);
    // The same two envelopes still open under their own label with the dual allowlist (the refusals above are not vacuous).
    expect(await openerFor(kms, [KEY_DEV, KEY_PROD]).open(devEnvelope, ctx({ env: "dev" }), read)).toBe(MARKER);
    expect(await openerFor(kms, [KEY_DEV, KEY_PROD]).open(prodEnvelope, ctx({ env: "prod" }), read)).toBe(MARKER);
    // Local keyring: the label alone changes the AAD, so no key-policy double is needed to refuse.
    const key = randomBytes(32);
    const local = createLocalKeyring(key, { NODE_ENV: "test" });
    const localProd = await createCredentialSealer(local.generator).seal(marker(), ctx({ env: "prod" }));
    expect(await codeOfFailure(createCredentialOpener(local.unwrapper).open(localProd, ctx({ env: "dev" }), read))).toBe("INTEGRITY_FAILURE");
    expect(await codeOfFailure(createCredentialOpener(local.unwrapper).open(localProd, ctx({ env: "test" }), read))).toBe("INTEGRITY_FAILURE");
  });

  it("cross workspace, cross credential id, and a tampered or widened context → REFUSED before or at the keyring", async () => {
    const kms = kmsDouble();
    const envelope = await sealerFor(kms, KEY_PROD).seal(marker(), ctx());
    const opener = openerFor(kms, [KEY_PROD]);
    expect(await codeOfFailure(opener.open(envelope, ctx({ workspaceId: randomUUID() }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED)$/);
    expect(await codeOfFailure(opener.open(envelope, ctx({ credentialId: randomUUID() }), read))).toMatch(/^(INTEGRITY_FAILURE|KEYRING_ACCESS_DENIED)$/);
    const sentBefore = kms.sent.length;
    const widened = { ...ctx(), provider: "meta" } as unknown as CredentialContext;
    const missing = Object.fromEntries(Object.entries(ctx()).filter(([k]) => k !== "env")) as unknown as CredentialContext;
    const retyped = { ...ctx(), v: 1 } as unknown as CredentialContext;
    for (const bad of [widened, missing, retyped]) expect(await codeOfFailure(opener.open(envelope, bad, read))).toBe("INVALID_CONTEXT");
    expect(kms.sent.length).toBe(sentBefore); // an invalid context never reaches KMS
  });

  it("a KeyId outside the allowlist is refused after Decrypt and its plaintext zeroed; a wrong physical key never opens", async () => {
    const kms = kmsDouble();
    const envelope = await sealerFor(kms, KEY_PROD).seal(marker(), ctx());
    // A prod runtime configured for ANOTHER prod key (rotation not yet allowing this one): refused, not opened.
    expect(await codeOfFailure(openerFor(kms, [KEY_PROD_OTHER_REGION]).open(envelope, ctx(), read))).toBe("KEYRING_MISCONFIGURED");
    expect(kms.sent.at(-1)?.kind).toBe("decrypt");
  });
});

describe("3. composition fails closed: no identity → no client; no KMS → never a local keyring outside development/test", () => {
  it("a KMS-configured prod environment with no AWS identity builds no client (KEYRING_MISCONFIGURED); region must be the key's", () => {
    const config = parseKmsKeyringConfig({ contextEnv: "prod", currentKeyArn: KEY_PROD, allowedKeyArns: KEY_PROD });
    expect(syncCode(() => createKmsClient(config, undefined))).toBe("KEYRING_MISCONFIGURED");
    expect(syncCode(() => createKmsClient({ ...config, region: "us-east-1" }, { getCredentials: () => Promise.reject(new Error("never")) } as never))).toBe("KEYRING_MISCONFIGURED");
  });

  it("selection: prod KMS variables select KMS with label prod; a local key next to them is refused; a deployed runtime without KMS is refused", () => {
    const prodKms = { CREDENTIAL_CONTEXT_ENV: "prod", CREDENTIAL_KMS_KEY_ARN: KEY_PROD, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_PROD };
    expect(selectCredentialCrypto({ NODE_ENV: "production", APP_DEPLOYMENT_ENV: "production", ...prodKms })).toMatchObject({ kind: "kms", config: { contextEnv: "prod" } });
    expect(credentialEnvironmentLabel({ NODE_ENV: "production", ...prodKms })).toBe("prod");
    expect(syncCode(() => selectCredentialCrypto({ NODE_ENV: "production", ...prodKms, LOCAL_KEYRING_KEY: "x" }))).toBe("KEYRING_MISCONFIGURED");
    expect(syncCode(() => selectCredentialCrypto({ NODE_ENV: "production", APP_DEPLOYMENT_ENV: "production" }))).toBe("KEYRING_MISCONFIGURED");
    expect(syncCode(() => selectCredentialCrypto({ NODE_ENV: "production", CREDENTIAL_CONTEXT_ENV: "prod" }))).toBe("KEYRING_MISCONFIGURED"); // partial
    expect(readKmsKeyringConfig({ NODE_ENV: "test" })).toBeUndefined();
    // Dev behaviour preserved: test → local/test, development → local/local; dev KMS still selects dev.
    expect(selectCredentialCrypto({ NODE_ENV: "test" })).toEqual({ kind: "local", contextEnv: "test" });
    expect(selectCredentialCrypto({ NODE_ENV: "development" })).toEqual({ kind: "local", contextEnv: "local" });
    expect(selectCredentialCrypto({ NODE_ENV: "production", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY_DEV, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_DEV })).toMatchObject({ kind: "kms", config: { contextEnv: "dev" } });
  });
});

describe("4. the worker identity is bound to the label: source contract and production templates agree (live cases: tests/unit/jobs/integration-aws-identity.test.ts)", () => {
  const adapter = codeOf("jobs/integration-aws-identity.ts");
  const prefix = JSON.parse(/^export const INTEGRATION_WORKLOAD_SUBJECT_CN_PREFIX = ([^;\n]+);$/m.exec(adapter)?.[1] ?? '""') as string;

  it("the adapter derives the subject CN from the credential context env, so a dev certificate can never serve prod", () => {
    expect(prefix).toBe("social-intelligence-platform-integration-");
    expect(adapter).toMatch(/names\[0\] !== `\$\{INTEGRATION_WORKLOAD_SUBJECT_CN_PREFIX\}\$\{kms\.contextEnv\}`\) return misconfigured\(\)/);
    expect(adapter).toMatch(/role\.partition !== key\.partition \|\| role\.account !== key\.account\) return misconfigured\(\)/);
  });

  it("the production trust and key-policy templates name exactly that CN and the prod label", () => {
    const trust = JSON.parse(readFileSync(path.join(root, "design/phase-7e/aws-authorization/production/artifacts/worker-trust-policy.json"), "utf8")) as { Statement: { Condition: { StringEquals: Record<string, string> } }[] };
    expect(trust.Statement[0]?.Condition.StringEquals["aws:PrincipalTag/x509Subject/CN"]).toBe(`${prefix}prod`);
    const decrypt = JSON.parse(readFileSync(path.join(root, "design/phase-7e/aws-authorization/production/artifacts/kms-worker-decrypt-statement.json"), "utf8")) as { Condition: { StringEquals: Record<string, string> } };
    expect(decrypt.Condition.StringEquals["kms:EncryptionContext:env"]).toBe("prod");
  });
});

describe("5. the KMS diagnostic pairs tiers with labels; MAIN and INTELLIGENCE still refuse every crypto variable", () => {
  it("staging ↔ dev, production ↔ prod in the source contract; the runtime pairing cases live in tests/unit/jobs/integration-kms-diagnostic.test.ts", () => {
    const source = codeOf("jobs/integration-kms-diagnostic.ts");
    expect(source).toMatch(/export const KMS_DIAGNOSTIC_TARGETS = Object\.freeze\(\{ staging: "dev", production: "prod" \} as const\);/);
    expect(source).toMatch(/if \(tier !== "staging" && tier !== "production"\) return undefined;/);
    expect(source).toMatch(/selection\.config\.contextEnv !== target\.contextEnv\) return refuse\("kms_diagnostic_credential_context_refused"\)/);
    expect(source).toMatch(/composed\.contextEnv !== target\.contextEnv\) refuse\("kms_diagnostic_credential_context_refused"\)/);
    expect(source).not.toMatch(/KMS_DIAGNOSTIC_TIER\b|KMS_DIAGNOSTIC_CONTEXT_ENV\b/);
  });

  it("plane allowlists: MAIN and INTELLIGENCE refuse the worker identity variables; INTEGRATION and INTELLIGENCE refuse the ambient AWS chain; MAIN refuses the model key", () => {
    for (const plane of ["main", "intelligence"] as const) {
      for (const name of ["INTEGRATION_AWS_WORKER_ROLE_ARN", "INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN", "INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN", "INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM", "INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM"]) {
        expect(PLANE_FORBIDDEN_VARIABLES[plane], `${plane} ${name}`).toContain(name);
      }
    }
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) {
      expect(PLANE_FORBIDDEN_VARIABLES.intelligence).toContain(name);
      expect(PLANE_FORBIDDEN_VARIABLES.integration).toContain(name);
    }
    expect(PLANE_FORBIDDEN_VARIABLES.main).toContain("INTELLIGENCE_MODEL_API_KEY");
  });
});

describe("6. normalized errors, no leakage, no real adapter", () => {
  it("KMS failures surface as fixed codes; nothing of the request, key, role or certificate survives in any rendering", async () => {
    const kms = kmsDouble();
    const envelope = await sealerFor(kms, KEY_PROD).seal(marker(), ctx());
    const denied = await openerFor(kms, [KEY_PROD]).open(envelope, ctx({ env: "dev" }), read).then(() => undefined, (e: unknown) => e);
    expect(denied).toBeInstanceOf(CredentialCryptoError);
    expect(isRetryableCredentialCryptoError(denied)).toBe(false);
    const rendered = [JSON.stringify(denied), String(denied), inspect(denied, { depth: 10, showHidden: true }), (denied as Error).stack ?? ""].join("\n");
    for (const needle of [MARKER, KEY_PROD, KEY_DEV, ACCOUNT_PROD, WORKSPACE, CREDENTIAL, "synthetic"]) expect(rendered).not.toContain(needle);
  });

  it("this suite never selects the real Meta adapter or any provider: NODE_ENV test without KMS is the local keyring, and no AWS SDK client is constructed", () => {
    expect(selectCredentialCrypto({ NODE_ENV: "test" })).toEqual({ kind: "local", contextEnv: "test" });
    const imports = codeOf("tests/unit/platform/credential-context-prod.test.ts").split("\n").filter((line) => line.startsWith("import "));
    for (const forbidden of ["@/jobs/connections", "@/integrations/providers", "@/server/connections/runtime", "@/jobs/integration-aws-identity", "aws-signing-helper"]) {
      expect(imports.join("\n")).not.toContain(forbidden);
    }
  });
});
