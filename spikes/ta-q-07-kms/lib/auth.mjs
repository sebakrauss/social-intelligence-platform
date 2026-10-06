/**
 * Operator authentication through the IAM Identity Center device flow (no AWS CLI, nothing on disk).
 * The SSO access token, the OIDC client secret and the role credentials live in process memory only and
 * are registered with the output guard. The operator approves the sign-in (with MFA) in the browser.
 */
import { RegisterClientCommand, SSOOIDCClient, StartDeviceAuthorizationCommand, CreateTokenCommand } from "@aws-sdk/client-sso-oidc";
import { GetRoleCredentialsCommand, ListAccountRolesCommand, SSOClient } from "@aws-sdk/client-sso";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { PERMISSION_SET, REGION } from "./config.mjs";
import { describeError, log, registerSecret } from "./guard.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function credentialsFrom(accessKeyId, secretAccessKey, sessionToken, expiration) {
  registerSecret(accessKeyId);
  registerSecret(secretAccessKey);
  registerSecret(sessionToken);
  // Deliberately NOT frozen: the AWS SDK (@aws-sdk/core setCredentialFeature) attaches a non-secret `$source`
  // attribution marker to user-supplied credential objects; a frozen object makes it throw a TypeError.
  return { accessKeyId, secretAccessKey, sessionToken, expiration: new Date(expiration) };
}

export async function operatorSignIn({ startUrl, accountId }) {
  const oidc = new SSOOIDCClient({ region: REGION });
  const client = await oidc.send(new RegisterClientCommand({ clientName: "sip-ta-q-07b-harness", clientType: "public" }));
  registerSecret(client.clientSecret);
  const device = await oidc.send(
    new StartDeviceAuthorizationCommand({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl }),
  );
  registerSecret(device.deviceCode);
  log(`[auth] ACTION REQUIRED — approve this sign-in in your browser within ${String(Math.floor(device.expiresIn / 60))} minutes:`);
  log(`[auth]   ${device.verificationUriComplete}`);
  log(`[auth]   The page must show this code: ${device.userCode}`);

  let interval = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expiresIn * 1000;
  let token = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      token = await oidc.send(
        new CreateTokenCommand({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          deviceCode: device.deviceCode,
        }),
      );
      break;
    } catch (error) {
      if (error?.name === "AuthorizationPendingException") continue;
      if (error?.name === "SlowDownException") {
        interval += 5000;
        continue;
      }
      throw Object.assign(new Error(`sign-in failed: ${describeError(error)}`), { name: "SignInFailed" });
    }
  }
  if (!token) throw Object.assign(new Error("sign-in was not approved in time"), { name: "SignInExpired" });
  registerSecret(token.accessToken);

  const sso = new SSOClient({ region: REGION });
  const roles = await sso.send(new ListAccountRolesCommand({ accessToken: token.accessToken, accountId }));
  if (!(roles.roleList ?? []).some((role) => role.roleName === PERMISSION_SET)) {
    throw Object.assign(new Error(`permission set ${PERMISSION_SET} is not assigned for the expected account`), { name: "PermissionSetMissing" });
  }
  const issued = await sso.send(new GetRoleCredentialsCommand({ accessToken: token.accessToken, accountId, roleName: PERMISSION_SET }));
  const c = issued.roleCredentials;
  log("[auth] signed in through IAM Identity Center (short-lived role credentials, memory only)");
  return credentialsFrom(c.accessKeyId, c.secretAccessKey, c.sessionToken, c.expiration);
}

export async function callerIdentity(credentials) {
  const sts = new STSClient({ region: REGION, credentials });
  return sts.send(new GetCallerIdentityCommand({}));
}

/** Assumes a test role from the operator session; retries only while IAM propagates a new trust policy. */
export async function assumeTestRole(operator, roleArnValue, sessionName, { waitSeconds = 90 } = {}) {
  const sts = new STSClient({ region: REGION, credentials: operator });
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArnValue, RoleSessionName: sessionName, DurationSeconds: 900 }));
      const c = out.Credentials;
      return credentialsFrom(c.AccessKeyId, c.SecretAccessKey, c.SessionToken, c.Expiration);
    } catch (error) {
      if (error?.name === "AccessDenied" && Date.now() < deadline) {
        await sleep(5000);
        continue;
      }
      throw Object.assign(new Error(`assume role failed: ${describeError(error)}`), { name: "AssumeRoleFailed" });
    }
  }
}
