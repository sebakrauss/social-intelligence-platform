/**
 * Read-only inventory of the TA-Q-07b development account (List/Get/Describe calls only; nothing is created,
 * changed or deleted). Confirms that exactly the approved resources exist and that no long-lived credential
 * or extra TA-Q-07b resource does. Used by `run.mjs reconcile` and as extra preflight checks (P6–P9).
 */
import { GetAccountSummaryCommand, IAMClient, ListAccessKeysCommand, ListRolesCommand, ListUsersCommand } from "@aws-sdk/client-iam";
import { DescribeKeyCommand, KMSClient, ListAliasesCommand, ListGrantsCommand, ListKeysCommand, ListResourceTagsCommand } from "@aws-sdk/client-kms";
import { KEY_SLOTS, PREFIX, REGION, ROLE_NAMES } from "../lib/config.mjs";

async function all(fetchPage, pick, next) {
  const items = [];
  for (let marker; ;) {
    const page = await fetchPage(marker);
    items.push(...(pick(page) ?? []));
    marker = next(page);
    if (!marker) return items;
  }
}

export async function inventoryChecks({ operator, keyArns }) {
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const kms = new KMSClient({ region: REGION, credentials: operator });
  const checks = [];
  const check = (id, title, pass) => checks.push({ id, title, pass: pass === true });

  const roles = await all((m) => iam.send(new ListRolesCommand({ Marker: m })), (p) => p.Roles, (p) => (p.IsTruncated ? p.Marker : undefined));
  const prefixed = roles.map((r) => r.RoleName).filter((n) => n.startsWith(PREFIX)).sort();
  check("P6a", "exactly the three approved IAM roles carry the development prefix", JSON.stringify(prefixed) === JSON.stringify(Object.values(ROLE_NAMES).sort()));

  const users = await all((m) => iam.send(new ListUsersCommand({ Marker: m })), (p) => p.Users, (p) => (p.IsTruncated ? p.Marker : undefined));
  let accessKeys = 0;
  for (const user of users) {
    const keys = await all((m) => iam.send(new ListAccessKeysCommand({ UserName: user.UserName, Marker: m })), (p) => p.AccessKeyMetadata, (p) => (p.IsTruncated ? p.Marker : undefined));
    accessKeys += keys.length;
  }
  check("P6b", "no IAM user carries the development prefix (no trigger-worker user)", !users.some((u) => u.UserName.startsWith(PREFIX)));
  check("P6c", "no IAM user access keys exist in the account (no long-lived credential)", accessKeys === 0);
  const summary = (await iam.send(new GetAccountSummaryCommand({}))).SummaryMap ?? {};
  check("P6d", "root has no access keys (AccountAccessKeysPresent = 0)", summary.AccountAccessKeysPresent === 0);

  const keys = await all((m) => kms.send(new ListKeysCommand({ Marker: m })), (p) => p.Keys, (p) => (p.Truncated ? p.NextMarker : undefined));
  const tagged = [];
  for (const k of keys) {
    const meta = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }))).KeyMetadata;
    if (meta.KeyManager !== "CUSTOMER" || meta.KeyState === "PendingDeletion") continue;
    const tags = (await kms.send(new ListResourceTagsCommand({ KeyId: k.KeyId }))).Tags ?? [];
    if (tags.some((t) => t.TagKey === "Validation" && t.TagValue === "TA-Q-07b")) tagged.push(meta.Arn);
  }
  check("P7a", "exactly three TA-Q-07b customer-managed keys exist, and they are keys A, B and C", JSON.stringify(tagged.sort()) === JSON.stringify(Object.values(keyArns).sort()));

  const aliases = await all((m) => kms.send(new ListAliasesCommand({ Marker: m })), (p) => p.Aliases, (p) => (p.Truncated ? p.NextMarker : undefined));
  const ours = aliases.filter((a) => a.AliasName.startsWith(`alias/${PREFIX}`));
  const expected = Object.entries(KEY_SLOTS).map(([slot, s]) => [s.alias, keyArns[slot].split("/").pop()]);
  check(
    "P7b",
    "exactly the three approved aliases exist, each targeting its key",
    ours.length === expected.length && expected.every(([name, keyId]) => ours.some((a) => a.AliasName === name && a.TargetKeyId === keyId)),
  );

  let grants = 0;
  for (const arn of Object.values(keyArns)) {
    grants += (await all((m) => kms.send(new ListGrantsCommand({ KeyId: arn, Marker: m })), (p) => p.Grants, (p) => (p.Truncated ? p.NextMarker : undefined))).length;
  }
  check("P8", "no KMS grants exist on keys A, B or C", grants === 0);
  return checks;
}
