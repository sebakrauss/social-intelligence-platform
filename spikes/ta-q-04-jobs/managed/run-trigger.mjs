// DISPOSABLE MANAGED SPIKE RUNNER — Trigger.dev DEVELOPMENT environment (social-intelligence-dev). NOT PRODUCTION.
// · Authoritative state: a throwaway LOCAL PostgreSQL (synthetic data only; ephemeral password, never persisted beyond .data/).
// · Orchestration: Trigger.dev cloud (Development). Task code executes on this machine via `trigger.dev dev` (documented).
// · Secrets come from the git-ignored .env.local; all child output is redacted before display or storage.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.loadEnvFile(path.join(root, '.env.local'));
const superPw = randomBytes(18).toString('base64url');
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const DB_URL = `postgres://spike_super:${superPw}@127.0.0.1:${port}/spike`;
const secrets = [process.env.TRIGGER_SECRET_KEY, process.env.TRIGGER_PROJECT_REF, superPw, DB_URL].filter(Boolean).sort((a, b) => b.length - a.length);
const redact = (s) => { let t = String(s); for (const v of secrets) t = t.split(v).join('<redacted>'); return t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').replace(/\x1b\[[0-9;]*m/g, ''); };

const dataDir = path.join(root, '.data', `trigger-cluster-${port}`);
const envFile = path.join(root, '.data', 'trigger-dev.env');
await rm(path.join(root, '.data'), { recursive: true, force: true });
await mkdir(path.join(root, '.data'), { recursive: true });
const cluster = new EmbeddedPostgres({ databaseDir: dataDir, port, user: 'spike_super', password: superPw, authMethod: 'scram-sha-256', persistent: false,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: () => {} });
await cluster.initialise(); await cluster.start();
let cli, exitCode = 1;
const cliLog = [];
try {
  await cluster.createDatabase('spike');
  const admin = new pg.Client({ connectionString: DB_URL }); await admin.connect();
  await admin.query(await readFile(path.join(root, 'sql', 'schema.sql'), 'utf8'));
  await admin.query(`create table trigger_log (id bigserial primary key, task text not null, entity_id uuid not null, run_id text not null, attempt int not null, outcome text not null, at timestamptz not null default clock_timestamp())`);
  await admin.end();
  await writeFile(envFile, `SPIKE_DATABASE_URL=${DB_URL}\n`, { mode: 0o600 });    // ephemeral local DB only; deleted below

  cli = spawn(path.join(root, 'node_modules', '.bin', 'trigger'), ['dev', 'start', '--env-file', envFile, '--skip-update-check', '--skip-telemetry', '--log-level', 'log'],
    { cwd: root, env: { ...process.env, SPIKE_DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] });
  cli.on('error', (e) => cliLog.push(`CLI spawn error: ${e.code}`));
  const ready = new Promise((resolve) => {
    const onData = (d) => { const t = redact(d.toString()); cliLog.push(t); if (/(ready|Local worker|waiting for|Running)/i.test(t)) resolve(true); };
    cli.stdout.on('data', onData); cli.stderr.on('data', onData);
    setTimeout(() => resolve(false), 120000);
  });
  const wasReady = await ready;
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`trigger.dev dev ready signal: ${wasReady}`);

  const out = [];
  exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-timeout=600000', path.join(root, 'managed', 'trigger.test.mjs')],
      { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TRIGGER_SECRET_KEY: process.env.TRIGGER_SECRET_KEY, SPIKE_DATABASE_URL: DB_URL } });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { const t = redact(d.toString()); process.stdout.write(t); out.push(t); });
    child.on('close', resolve);
  });
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  const cliSummary = cliLog.join('').split('\n').filter((l) => /(worker|version|ready|Run|run_|error|warn|attempt|crash|retry)/i.test(l)).slice(-80).join('\n');
  await writeFile(path.join(root, 'evidence', 'ta-q-04-trigger-managed-output.txt'),
    `TA-Q-04 MANAGED run — Trigger.dev DEVELOPMENT environment — ${new Date().toISOString()}\nexit code: ${exitCode}\n` +
    `Task code executed locally via \`trigger.dev dev\` (documented dev behavior); orchestration in Trigger.dev cloud.\n\n` +
    out.join('') + `\n\n--- trigger.dev dev CLI log (filtered, redacted) ---\n${cliSummary}\n`);
} finally {
  if (cli) { cli.kill('SIGINT'); await new Promise((r) => setTimeout(r, 3000)); if (!cli.killed) cli.kill('SIGKILL'); }
  await cluster.stop();
  await rm(path.join(root, '.data'), { recursive: true, force: true });           // removes the ephemeral env file too
}
process.exit(exitCode);
