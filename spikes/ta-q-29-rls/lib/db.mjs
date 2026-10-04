// DISPOSABLE SPIKE — NOT PRODUCTION CODE.
// The three scope helpers from TA §9.3, implemented with Drizzle over node-postgres pools.
// Each runtime connects with its OWN low-privilege login role (never `postgres`, never service_role).
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean } from 'drizzle-orm/pg-core';
import { verifyAccessToken } from './auth.mjs';

export const conversations = pgTable('conversations', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), title: text('title').notNull() });
export const interactions = pgTable('interactions', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), conversationId: uuid('conversation_id').notNull(), body: text('body').notNull() });
export const guestInsights = pgTable('guest_insights', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), statement: text('statement').notNull() });
export const attentionSignals = pgTable('attention_signals', { workspaceId: uuid('workspace_id').primaryKey(), needsAttention: boolean('needs_attention').notNull() });

const base = { host: '127.0.0.1', port: Number(process.env.SPIKE_PGPORT), database: 'spike' };

// `max` is configurable so tests can force reuse of ONE server connection (transaction-pooling emulation).
export function makePools({ max = 1 } = {}) {
  const web = new pg.Pool({ ...base, user: 'web_login', password: process.env.SPIKE_WEB_PW, max });
  const worker = new pg.Pool({ ...base, user: 'worker_login', password: process.env.SPIKE_WORKER_PW, max });
  const system = new pg.Pool({ ...base, user: 'system_login', password: process.env.SPIKE_SYSTEM_PW, max });
  return {
    web, worker, system,
    webDb: drizzle(web), workerDb: drizzle(worker), systemDb: drizzle(system),
    end: () => Promise.all([web.end(), worker.end(), system.end()]),
  };
}

// USER SCOPE (web requests): verify token server-side -> transaction-local role + claims + sealed workspace context.
export async function withUserScope(pools, accessToken, workspaceId, fn) {
  const claims = await verifyAccessToken(accessToken);           // throws before touching the database
  return pools.webDb.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);         // fixed literal; never taken from the token
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                                set_config('request.jwt.claim.sub', ${claims.sub}, true)`);
    await tx.execute(sql`select app.bind_context(${workspaceId}::uuid)`);
    return fn(tx);
  });
}

// WORKSPACE JOB SCOPE (workers): restricted worker role + sealed workspace context.
export async function withWorkspaceJobScope(pools, workspaceId, fn) {
  return pools.workerDb.transaction(async (tx) => {
    await tx.execute(sql`set local role app_worker`);
    await tx.execute(sql`select app.bind_context(${workspaceId}::uuid)`);
    return fn(tx);
  });
}

// SYSTEM SCOPE (named system jobs only): system role, system tables only.
export async function withSystemScope(pools, fn) {
  return pools.systemDb.transaction(async (tx) => {
    await tx.execute(sql`set local role app_system`);
    return fn(tx);
  });
}

export const rows = (r) => r.rows ?? r;
