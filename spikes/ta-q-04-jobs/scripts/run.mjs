// DISPOSABLE SPIKE RUNNER — starts a throwaway local PostgreSQL (repo-local binaries via embedded-postgres),
// loads the synthetic fixture, runs the test suite, writes evidence, and deletes the cluster.
// Passwords are random per run, passed only via environment variables, never written to disk.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pw = () => randomBytes(18).toString('base64url');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const superPw = pw();
const dataDir = path.join(root, '.data', `cluster-${port}`);
await rm(path.join(root, '.data'), { recursive: true, force: true });

const cluster = new EmbeddedPostgres({
  databaseDir: dataDir, port, user: 'spike_super', password: superPw, authMethod: 'scram-sha-256', persistent: false,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: (e) => console.error('[postgres]', String(e).trim()),
});
await cluster.initialise();
await cluster.start();
let exitCode = 1;
try {
  await cluster.createDatabase('spike');
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'spike_super', password: superPw, database: 'spike' });
  await admin.connect();
  await admin.query(await readFile(path.join(root, 'sql', 'schema.sql'), 'utf8'));
  const version = (await admin.query('select version()')).rows[0].version;
  await admin.end();
  const { runMigrations } = await import('graphile-worker');
  await runMigrations({ connectionString: `postgres://spike_super:${superPw}@127.0.0.1:${port}/spike` });
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  const env = { ...process.env, SPIKE_DATABASE_URL: `postgres://spike_super:${superPw}@127.0.0.1:${port}/spike` };
  const out = [];
  exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'tests/*.test.mjs'], { cwd: root, env });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { process.stdout.write(d); out.push(d); });
    child.on('close', resolve);
  });
  const header = `TA-Q-04 spike run — ${new Date().toISOString()}\n${version}\nnode ${process.version}\nexit code: ${exitCode}\n\n`;
  await writeFile(path.join(root, 'evidence', 'ta-q-04-test-output.txt'), header + Buffer.concat(out).toString().replace(/\x1b\[[0-9;]*m/g, ''));
} finally {
  await cluster.stop();                       // persistent:false => cluster files are deleted
  await rm(path.join(root, '.data'), { recursive: true, force: true });
}
process.exit(exitCode);
