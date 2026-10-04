// DISPOSABLE SPIKE — read-only credential preflight. Prints only booleans / non-secret facts.
process.loadEnvFile(new URL('../.env.local', import.meta.url));
const base = process.env.SUPABASE_URL;
const res = {};
try {
  const jwks = await (await fetch(`${base}/auth/v1/.well-known/jwks.json`)).json();
  res.jwks_asymmetric_keys = (jwks.keys ?? []).map((k) => `${k.kty}/${k.alg}`);
} catch (e) { res.jwks_error = e.message; }
try {
  const r = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } });
  const s = await r.json();
  res.publishable_key_accepted = r.ok;
  res.email_provider_enabled = s?.external?.email ?? null;
  res.signup_disabled = s?.disable_signup ?? null;
} catch (e) { res.publishable_error = e.message; }
try {
  const r = await fetch(`${base}/auth/v1/admin/users?per_page=1`, { headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` } });
  res.secret_key_admin_read_ok = r.ok; res.secret_key_status = r.status;
} catch (e) { res.secret_error = e.message; }
try {
  process.loadEnvFile(new URL('../../ta-q-04-jobs/.env.local', import.meta.url));
  const r = await fetch('https://api.trigger.dev/api/v1/runs?page[size]=1', { headers: { Authorization: `Bearer ${process.env.TRIGGER_SECRET_KEY}` } });
  res.trigger_secret_key_ok = r.ok; res.trigger_status = r.status;
  res.trigger_key_is_dev = process.env.TRIGGER_SECRET_KEY.startsWith('tr_dev_');
  res.trigger_project_ref_shape_ok = /^proj_[a-z0-9]+$/.test(process.env.TRIGGER_PROJECT_REF);
} catch (e) { res.trigger_error = e.message; }
console.log(JSON.stringify(res, null, 2));
