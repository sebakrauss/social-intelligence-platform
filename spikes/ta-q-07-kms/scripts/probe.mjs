/**
 * The TA-Q-07b managed matrix (W, K, E, T, R). Synthetic data only: random UUIDs for workspaces and
 * credentials, a random 32-byte synthetic secret. DEKs and plaintext are Buffers that are zeroed after use;
 * envelopes live in memory only; nothing secret is ever printed or written.
 *
 * Destructive negative tests (DisableKey, ScheduleKeyDeletion, PutKeyPolicy) target the decoy key C with a
 * no-op payload; CreateGrant uses DryRun. An unexpected success is reverted and stops the run.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CancelKeyDeletionCommand, CreateGrantCommand, DecryptCommand, DisableKeyCommand, EnableKeyCommand, EncryptCommand,
  GenerateDataKeyCommand, GenerateDataKeyWithoutPlaintextCommand, KMSClient, PutKeyPolicyCommand, ReEncryptCommand,
  ScheduleKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import { CONTEXT_CONSTANTS, NEGATIVE_LITERALS, REGION, SESSION_PREFIX } from "../lib/config.mjs";
import { asBuffer, fingerprint, named, open, seal, tamper, zero } from "../lib/envelope.mjs";
import { assumeTestRole } from "../lib/auth.mjs";
import { log } from "../lib/guard.mjs";
import { keyPolicy, roleArn } from "../lib/policies.mjs";
import { StopValidation } from "../lib/recorder.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ctx = (workspace, credential, extra = {}) => ({ ...CONTEXT_CONSTANTS, workspace_id: workspace, credential_id: credential, ...extra });
const without = (context, key) => Object.fromEntries(Object.entries(context).filter(([k]) => k !== key));
const DENIED = "AccessDeniedException";

function zeroOutput(output) {
  if (output?.Plaintext instanceof Uint8Array) output.Plaintext.fill(0);
  return output;
}

function equalSecret(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function probe({ operator, account, keyArns, rec, runId }) {
  const ids = {
    wsA: randomUUID(), wsB: randomUUID(), wsM: randomUUID(), wsW: randomUUID(),
    credX: randomUUID(), credY: randomUUID(), credZ: randomUUID(), credT: randomUUID(), credW: randomUUID(),
  };
  const sessions = {};
  for (const role of ["web", "worker", "rotation"]) {
    sessions[role] = await assumeTestRole(operator, roleArn(account, role), `${SESSION_PREFIX}-${role}-${runId}`);
  }
  log("[probe] assumed web-encrypt, integration-worker and kms-rotation-test sessions (15 minutes, memory only)");
  const clients = {
    web: new KMSClient({ region: REGION, credentials: sessions.web, maxAttempts: 2 }),
    worker: new KMSClient({ region: REGION, credentials: sessions.worker, maxAttempts: 2 }),
    rotation: new KMSClient({ region: REGION, credentials: sessions.rotation, maxAttempts: 2 }),
  };
  const operatorKms = new KMSClient({ region: REGION, credentials: operator });
  const call = (role, Command, input) => rec.kms(role, clients[role], Command, input);
  const { A, B, C } = keyArns;
  const ctxAX = ctx(ids.wsA, ids.credX);

  // Reverts for destructive admin calls on the decoy key, used only if a runtime role was unexpectedly allowed.
  const revertDecoy = async () => {
    for (const Command of [CancelKeyDeletionCommand, EnableKeyCommand]) {
      try {
        await operatorKms.send(new Command({ KeyId: C }));
      } catch {
        // already in the desired state
      }
    }
  };
  const deny = (id, title, role, Command, input, revert) =>
    rec.expect(id, title, async () => zeroOutput(await call(role, Command, input)), DENIED, revert ? { onUnexpectedSuccess: revert } : {});

  const adminNegatives = async (prefix, role) => {
    await deny(`${prefix}c`, `${role} CreateGrant(A) [DryRun] denied`, role, CreateGrantCommand, {
      KeyId: A, GranteePrincipal: roleArn(account, role), Operations: ["Decrypt"], DryRun: true,
    });
    await deny(`${prefix}d`, `${role} DisableKey(C) denied`, role, DisableKeyCommand, { KeyId: C }, revertDecoy);
    await deny(`${prefix}e`, `${role} ScheduleKeyDeletion(C, 30 days) denied`, role, ScheduleKeyDeletionCommand, { KeyId: C, PendingWindowInDays: 30 }, revertDecoy);
    await deny(`${prefix}f`, `${role} PutKeyPolicy(C, identical policy) denied`, role, PutKeyPolicyCommand, {
      KeyId: C, PolicyName: "default", Policy: JSON.stringify(keyPolicy("C", account)),
    });
  };

  // ── Warm-up: wait until the new key policies and roles are effective (positive paths only) ────────────
  const warm = async (label, fn) => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error?.name === DENIED && Date.now() < deadline) {
          await sleep(5000);
          continue;
        }
        throw new StopValidation(`warm-up ${label} did not become effective (${error?.name ?? "Error"})`);
      }
    }
  };
  const ctxW = ctx(ids.wsW, ids.credW);
  const warmBlob = await warm("web", async () => {
    const out = await call("web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctxW });
    zeroOutput(out);
    return out.CiphertextBlob;
  });
  await warm("worker", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: warmBlob, EncryptionContext: ctxW })));
  await warm("rotation", async () =>
    call("rotation", ReEncryptCommand, {
      CiphertextBlob: warmBlob, SourceKeyId: A, SourceEncryptionContext: ctxW, DestinationKeyId: A, DestinationEncryptionContext: ctxW,
    }),
  );
  log("[probe] warm-up complete: key policies and roles are effective");

  const secret = randomBytes(32);
  let dekW1Fp;
  let wrappedW1;
  let envW1;
  let e1Zeroed = false;

  try {
    // ── W: encrypt-only web principal ──────────────────────────────────────────────────────────────────
    await rec.expect("W1", "web GenerateDataKey(A, AES_256, valid context) succeeds", async () => {
      const out = await call("web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctxAX });
      const dek = asBuffer(out.Plaintext);
      try {
        if (dek.length !== 32) throw named("UnexpectedDekLength");
        if (out.KeyId !== A) throw named("UnexpectedKeyId");
        dekW1Fp = fingerprint(dek);
        wrappedW1 = Buffer.from(out.CiphertextBlob);
        envW1 = seal(dek, secret, ctxAX);
      } finally {
        e1Zeroed = zero(dek);
      }
    }, "ok");
    rec.assert("E1", "envelope sealed locally (AES-256-GCM, 96-bit IV, 128-bit tag, context AAD); plaintext DEK zeroed", e1Zeroed && envW1.iv.length === 12 && envW1.tag.length === 16 && envW1.ciphertext.length === secret.length);

    await deny("W2", "web GenerateDataKey without context denied", "web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256" });
    await deny("W3", "web GenerateDataKey missing credential_id denied", "web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: without(ctxAX, "credential_id") });
    await deny("W4", "web GenerateDataKey with an extra context key denied", "web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: { ...ctxAX, [NEGATIVE_LITERALS.extraKey]: NEGATIVE_LITERALS.extraValue } });
    await deny("W5", "web GenerateDataKey with a non-UUID workspace_id denied", "web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: { ...ctxAX, workspace_id: NEGATIVE_LITERALS.invalidWorkspace } });
    await deny("W6", "web GenerateDataKey with env=prod denied", "web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: { ...ctxAX, env: NEGATIVE_LITERALS.wrongEnv } });
    await deny("W7", "web Decrypt(own wrapped DEK, correct context) denied", "web", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctxAX });
    await deny("W8", "web ReEncrypt denied", "web", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: A, DestinationEncryptionContext: ctxAX });
    await deny("W9a", "web GenerateDataKey on key B denied", "web", GenerateDataKeyCommand, { KeyId: B, KeySpec: "AES_256", EncryptionContext: ctxAX });
    await deny("W9b", "web GenerateDataKey on decoy key C denied", "web", GenerateDataKeyCommand, { KeyId: C, KeySpec: "AES_256", EncryptionContext: ctxAX });
    await deny("W10a", "web Encrypt denied", "web", EncryptCommand, { KeyId: A, Plaintext: randomBytes(16), EncryptionContext: ctxAX });
    await deny("W10b", "web GenerateDataKeyWithoutPlaintext denied", "web", GenerateDataKeyWithoutPlaintextCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctxAX });
    await adminNegatives("W10", "web");

    // ── K: integration-worker principal ────────────────────────────────────────────────────────────────
    let e2 = false;
    await rec.expect("K1", "worker Decrypt(W1 wrapped DEK, correct context, KeyId A) succeeds and returns the same DEK", async () => {
      const out = await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctxAX });
      const dek = asBuffer(out.Plaintext);
      try {
        if (!fingerprint(dek).equals(dekW1Fp)) throw named("DekMismatch");
        const plaintext = open(dek, envW1, ctxAX);
        try {
          e2 = equalSecret(plaintext, secret);
        } finally {
          zero(plaintext);
        }
      } finally {
        zero(dek);
      }
    }, "ok");
    rec.assert("E2", "envelope round-trip: worker-unwrapped DEK decrypts the synthetic secret locally (DEK and plaintext zeroed)", e2);

    await rec.expect("K2", "worker Decrypt with workspace B fails", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctx(ids.wsB, ids.credX) })), "InvalidCiphertextException");
    await rec.expect("K3", "worker Decrypt with credential Y fails", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctx(ids.wsA, ids.credY) })), "InvalidCiphertextException");
    await deny("K4", "worker Decrypt without context denied (policy)", "worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1 });
    await deny("K5a", "worker Decrypt missing credential_id denied (policy)", "worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: without(ctxAX, "credential_id") });
    await deny("K5b", "worker Decrypt with an extra context key denied (policy)", "worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: { ...ctxAX, [NEGATIVE_LITERALS.extraKey]: NEGATIVE_LITERALS.extraValue } });
    await deny("K5c", "worker Decrypt with a non-UUID workspace_id denied (policy)", "worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: { ...ctxAX, workspace_id: NEGATIVE_LITERALS.invalidWorkspace } });
    await deny("K6a", "worker GenerateDataKey on key B denied", "worker", GenerateDataKeyCommand, { KeyId: B, KeySpec: "AES_256", EncryptionContext: ctxAX });
    await deny("K6b", "worker GenerateDataKey on decoy key C denied", "worker", GenerateDataKeyCommand, { KeyId: C, KeySpec: "AES_256", EncryptionContext: ctxAX });
    await deny("K8a", "worker ReEncrypt denied", "worker", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: A, DestinationEncryptionContext: ctxAX });
    await deny("K8b", "worker Encrypt denied", "worker", EncryptCommand, { KeyId: A, Plaintext: randomBytes(16), EncryptionContext: ctxAX });
    await adminNegatives("K8", "worker");
    let wrappedK9;
    await rec.expect("K9", "worker GenerateDataKey(A, valid context) succeeds (refresh path); DEK zeroed", async () => {
      const out = await call("worker", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctx(ids.wsA, ids.credZ) });
      wrappedK9 = Buffer.from(out.CiphertextBlob);
      if (!zero(asBuffer(out.Plaintext))) throw named("DekNotZeroed");
    }, "ok");

    // ── E3: tampering ──────────────────────────────────────────────────────────────────────────────────
    const withWorkerDek = async (fn) => {
      const out = await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctxAX });
      const dek = asBuffer(out.Plaintext);
      try {
        return fn(dek);
      } finally {
        zero(dek);
      }
    };
    const openMustFail = (envelope, context) => withWorkerDek((dek) => zero(open(dek, envelope, context)));
    await rec.expect("E3a", "one flipped ciphertext bit fails GCM authentication", () => openMustFail(tamper(envW1, "ciphertext"), ctxAX), "AuthenticationFailed");
    await rec.expect("E3b", "one flipped tag bit fails GCM authentication", () => openMustFail(tamper(envW1, "tag"), ctxAX), "AuthenticationFailed");
    await rec.expect("E3c", "one flipped IV bit fails GCM authentication", () => openMustFail(tamper(envW1, "iv"), ctxAX), "AuthenticationFailed");
    await rec.expect("E3d", "local AAD for workspace B fails GCM authentication", () => openMustFail(envW1, ctx(ids.wsB, ids.credX)), "AuthenticationFailed");
    await rec.expect("E3e", "one flipped bit in the wrapped DEK fails KMS Decrypt", async () => {
      const corrupted = Buffer.from(wrappedW1);
      corrupted[corrupted.length - 1] ^= 0x01;
      return zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: corrupted, EncryptionContext: ctxAX }));
    }, "InvalidCiphertextException");
    await rec.expect("E3f", "another record's wrapped DEK under this record's context fails KMS Decrypt", async () =>
      zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedK9, EncryptionContext: ctxAX })), "InvalidCiphertextException");

    // ── T: tenant/context binding on a fresh envelope ──────────────────────────────────────────────────
    const ctxAT = ctx(ids.wsA, ids.credT);
    const secretT = randomBytes(32);
    let wrappedT;
    let envT;
    try {
      await rec.expect("T0", "web seals a fresh envelope for workspace A / credential T", async () => {
        const out = await call("web", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctxAT });
        const dek = asBuffer(out.Plaintext);
        try {
          wrappedT = Buffer.from(out.CiphertextBlob);
          envT = seal(dek, secretT, ctxAT);
        } finally {
          zero(dek);
        }
      }, "ok");
      let t1 = false;
      await rec.expect("T1", "correct workspace and credential decrypt", async () => {
        const out = await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedT, EncryptionContext: ctxAT });
        const dek = asBuffer(out.Plaintext);
        try {
          const plaintext = open(dek, envT, ctxAT);
          t1 = equalSecret(plaintext, secretT);
          zero(plaintext);
        } finally {
          zero(dek);
        }
        if (!t1) throw named("PlaintextMismatch");
      }, "ok");
      await rec.expect("T2", "workspace B fails", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedT, EncryptionContext: ctx(ids.wsB, ids.credT) })), "InvalidCiphertextException");
      await rec.expect("T3", "credential Y fails", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedT, EncryptionContext: ctx(ids.wsA, ids.credY) })), "InvalidCiphertextException");
      await rec.expect("T4", "tampered envelope fails", async () => {
        const out = await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedT, EncryptionContext: ctxAT });
        const dek = asBuffer(out.Plaintext);
        try {
          zero(open(dek, tamper(envT, "ciphertext"), ctxAT));
        } finally {
          zero(dek);
        }
      }, "AuthenticationFailed");
    } finally {
      zero(secretT);
    }

    // ── R: ReEncrypt (rotation-test principal) ─────────────────────────────────────────────────────────
    let blobB;
    await rec.expect("R1", "rotation ReEncrypt A→B (same context) succeeds; response carries no Plaintext; KeyId is B", async () => {
      const out = await call("rotation", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: B, DestinationEncryptionContext: ctxAX });
      if (Object.keys(out).some((key) => /plaintext/i.test(key))) throw named("PlaintextInResponse");
      if (out.KeyId !== B) throw named("UnexpectedKeyId");
      blobB = Buffer.from(out.CiphertextBlob);
    }, "ok");
    let r2 = false;
    await rec.expect("R2", "worker decrypts the re-wrapped DEK under B (same DEK) and opens the ORIGINAL ciphertext unchanged", async () => {
      const out = await call("worker", DecryptCommand, { KeyId: B, CiphertextBlob: blobB, EncryptionContext: ctxAX });
      const dek = asBuffer(out.Plaintext);
      try {
        if (!fingerprint(dek).equals(dekW1Fp)) throw named("DekMismatch");
        const plaintext = open(dek, envW1, ctxAX);
        r2 = equalSecret(plaintext, secret);
        zero(plaintext);
      } finally {
        zero(dek);
      }
      if (!r2) throw named("PlaintextMismatch");
    }, "ok");
    await rec.expect("R3", "re-wrapped DEK presented with KeyId A fails", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: blobB, EncryptionContext: ctxAX })), "IncorrectKeyException");
    let blobM;
    await rec.expect("R4", "rotation ReEncrypt on A with a context change (workspace A → M) succeeds", async () => {
      const out = await call("rotation", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: A, DestinationEncryptionContext: ctx(ids.wsM, ids.credX) });
      blobM = Buffer.from(out.CiphertextBlob);
    }, "ok");
    await rec.expect("R4b", "worker decrypts with the destination context (same DEK)", async () => {
      const out = await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: blobM, EncryptionContext: ctx(ids.wsM, ids.credX) });
      const dek = asBuffer(out.Plaintext);
      try {
        if (!fingerprint(dek).equals(dekW1Fp)) throw named("DekMismatch");
      } finally {
        zero(dek);
      }
    }, "ok");
    await rec.expect("R4c", "the old context no longer decrypts the re-wrapped DEK", async () => zeroOutput(await call("worker", DecryptCommand, { KeyId: A, CiphertextBlob: blobM, EncryptionContext: ctxAX })), "InvalidCiphertextException");
    await deny("R5a", "rotation Decrypt denied", "rotation", DecryptCommand, { KeyId: A, CiphertextBlob: wrappedW1, EncryptionContext: ctxAX });
    await deny("R5b", "rotation GenerateDataKey denied", "rotation", GenerateDataKeyCommand, { KeyId: A, KeySpec: "AES_256", EncryptionContext: ctxAX });

    // R6: how do the context conditions apply to ReEncrypt's DESTINATION context? (measurement)
    const r6Cases = [
      ["R6a", "destination context with an extra key", { ...ctxAX, [NEGATIVE_LITERALS.extraKey]: NEGATIVE_LITERALS.extraValue }],
      ["R6b", "destination context with a non-UUID workspace_id", { ...ctxAX, workspace_id: NEGATIVE_LITERALS.invalidWorkspace }],
      ["R6c", "destination context missing credential_id", without(ctxAX, "credential_id")],
      ["R6d", "no destination context at all", undefined],
    ];
    const r6 = {};
    for (const [id, label, destination] of r6Cases) {
      const input = { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: A };
      if (destination) input.DestinationEncryptionContext = destination;
      const { observed, value } = await rec.measure(id, `rotation ReEncrypt A→A with ${label}`, () => call("rotation", ReEncryptCommand, input));
      r6[id] = observed;
      if (observed === "ok") {
        // Whatever ReEncrypt allowed, the worker must still be unable to use it.
        const decryptInput = { KeyId: A, CiphertextBlob: Buffer.from(value.CiphertextBlob) };
        if (destination) decryptInput.EncryptionContext = destination;
        await deny(`${id}-verify`, `worker cannot decrypt the ${label} result (policy)`, "worker", DecryptCommand, decryptInput);
      }
    }
    // R6e: the SOURCE side — a policy-invalid source context can't be presented for a valid blob anyway;
    // check that ReEncrypt from an invalid source context is refused before any re-wrap.
    await rec.measure("R6e", "rotation ReEncrypt with a source context carrying an extra key", () =>
      call("rotation", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: { ...ctxAX, [NEGATIVE_LITERALS.extraKey]: NEGATIVE_LITERALS.extraValue }, DestinationKeyId: A, DestinationEncryptionContext: ctxAX }),
    );

    let blobC;
    await rec.expect("R7", "rotation ReEncrypt A→C (decoy destination, test-only grant) succeeds", async () => {
      const out = await call("rotation", ReEncryptCommand, { CiphertextBlob: wrappedW1, SourceKeyId: A, SourceEncryptionContext: ctxAX, DestinationKeyId: C, DestinationEncryptionContext: ctxAX });
      blobC = Buffer.from(out.CiphertextBlob);
    }, "ok");
    await deny("K7", "worker Decrypt of a DEK wrapped under decoy key C denied (key scoping)", "worker", DecryptCommand, { KeyId: C, CiphertextBlob: blobC, EncryptionContext: ctxAX });
    await deny("R8", "rotation ReEncrypt FROM key B denied (no ReEncryptFrom on B)", "rotation", ReEncryptCommand, { CiphertextBlob: blobB, SourceKeyId: B, SourceEncryptionContext: ctxAX, DestinationKeyId: A, DestinationEncryptionContext: ctxAX });
    await adminNegatives("R9", "rotation");

    return { r6, ids: Object.keys(ids).length };
  } finally {
    zero(secret);
    log("[probe] synthetic secret zeroed; envelopes discarded (memory only)");
  }
}
