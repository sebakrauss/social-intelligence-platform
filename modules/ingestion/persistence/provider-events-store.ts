/**
 * Provider-event inbox persistence (Step H6-F3; migration 0022). Thin adapters over the reviewed definers and the one
 * table read app_system holds (identifier-only hints); no generic repository over the system tables.
 *
 *   recordProviderWebhook   WEB provider-signal scope only: system.record_provider_webhook. The ONLY place raw body bytes
 *                           travel, and only when the adapter's own `rawBodyRetainable` says so (D-F4; never re-decided).
 *   ProviderEventStore      SYSTEM scope only (the MAIN router and purge): due hint ids, system.route_provider_hint,
 *                           system.purge_provider_events and (H6-F4) system.dispatch_due_signal_marks. Identifiers,
 *                           outcomes and counts — never a body.
 * Every definer result is validated against its closed vocabulary; anything else fails closed.
 */
import { sql } from "drizzle-orm";
import type { VerifiedWebhookDelivery } from "@/integrations/providers/contract";
import type { DatabaseTransaction } from "@/platform/db";
import type { ProviderEventStore } from "../application/provider-events";
import { isReceiptOutcome, isRouteOutcome, type ReceiptOutcome, type RouteOutcome } from "../domain/provider-events";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProviderWebhookReceipt {
  readonly outcome: ReceiptOutcome;
  readonly receiptId: string;
  readonly newHintCount: number;
  readonly knownHintCount: number;
}

/** The 0022 receipt hint shape: the H6-F1 hint's identifiers, nothing else (no text, author, body or header). */
function receiptHints(delivery: VerifiedWebhookDelivery): string {
  return JSON.stringify(delivery.hints.map((hint) => ({
    platform: hint.account.platform,
    provider_asset_id: hint.account.id,
    target_kind: hint.target.kind,
    provider_target_id: hint.target.id,
    provider_content_id: hint.content?.id ?? null,
    provider_parent_id: hint.parent?.id ?? null,
    change: hint.change,
    occurred_at: hint.occurredAt,
    hint_key: hint.eventId,
  })));
}

/**
 * Records one VERIFIED delivery (dedupe + receipt + hints, atomically, inside the caller's provider-signal scope).
 * `bytes` are the exact verified body; they reach the database only when the delivery is retainable.
 */
export async function recordProviderWebhook(tx: DatabaseTransaction, delivery: VerifiedWebhookDelivery, bytes: Uint8Array): Promise<ProviderWebhookReceipt> {
  const body = delivery.rawBodyRetainable ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  const result = await tx.execute<{ outcome: unknown; receipt_id: unknown; new_hint_count: unknown; known_hint_count: unknown }>(sql`
    select outcome, receipt_id, new_hint_count, known_hint_count
      from system.record_provider_webhook(${delivery.provider}, ${delivery.object}, ${delivery.bodySha256}, ${body}, ${bytes.byteLength},
                                          ${delivery.rawBodyRetainable}, ${delivery.entryCount}, ${delivery.changeCount}, ${delivery.ignoredEventCount},
                                          ${delivery.unsupportedChangeCount}, ${delivery.duplicateHintCount}, ${receiptHints(delivery)}::jsonb)`);
  const row = result.rows[0];
  const receiptId = row?.receipt_id;
  if (row === undefined || !isReceiptOutcome(row.outcome) || typeof receiptId !== "string" || !UUID.test(receiptId)
      || typeof row.new_hint_count !== "number" || typeof row.known_hint_count !== "number") {
    throw new Error("provider_webhook_receipt_unrecognized");
  }
  return Object.freeze({ outcome: row.outcome, receiptId, newHintCount: row.new_hint_count, knownHintCount: row.known_hint_count });
}

/** The system-scope store of the MAIN router and purge (app_system: SELECT on hints; the definers for the rest). */
export function createPostgresProviderEventStore(tx: DatabaseTransaction): ProviderEventStore {
  return Object.freeze({
    async listDueHints(limit) {
      const result = await tx.execute<{ id: string }>(sql`
        select id from system.provider_event_hints
         where state in ('PENDING', 'RETRYABLE') and (next_route_at is null or next_route_at <= pg_catalog.statement_timestamp())
         order by next_route_at nulls first, received_at, id
         limit ${limit}`);
      return Object.freeze(result.rows.map((row) => row.id));
    },
    async routeHint(hintId): Promise<RouteOutcome> {
      const result = await tx.execute<{ outcome: unknown }>(sql`select outcome from system.route_provider_hint(${hintId}::uuid)`);
      const outcome = result.rows[0]?.outcome;
      if (!isRouteOutcome(outcome)) throw new Error("provider_hint_route_unrecognized");
      return outcome;
    },
    async purgeExpired(limit) {
      const result = await tx.execute<{ inbox_deleted: unknown; hints_deleted: unknown }>(sql`select inbox_deleted, hints_deleted from system.purge_provider_events(${limit})`);
      const row = result.rows[0];
      if (row === undefined || typeof row.inbox_deleted !== "number" || typeof row.hints_deleted !== "number") throw new Error("provider_event_purge_unrecognized");
      return Object.freeze({ inboxDeleted: row.inbox_deleted, hintsDeleted: row.hints_deleted });
    },
    async dispatchDueMarks(limit) {
      const result = await tx.execute<{ dispatched: unknown }>(sql`select dispatched from system.dispatch_due_signal_marks(${limit})`);
      const dispatched = result.rows[0]?.dispatched;
      if (typeof dispatched !== "number") throw new Error("signal_mark_dispatch_unrecognized");
      return dispatched;
    },
  } satisfies ProviderEventStore);
}
