// DISPOSABLE SPIKE — a worker process the test kills with SIGKILL mid-job (hard crash, no graceful shutdown).
import pg from 'pg';
import { run } from 'graphile-worker';
import { makeTasks } from '../lib/outbox.mjs';

const pool = new pg.Pool({ connectionString: process.env.SPIKE_DATABASE_URL, max: 4 });
await run({ connectionString: process.env.SPIKE_DATABASE_URL, concurrency: 1, noHandleSignals: true, pollInterval: 200,
  workerId: process.env.SPIKE_WORKER_ID, taskList: makeTasks(pool) });
process.stdout.write('crash-worker started\n');
