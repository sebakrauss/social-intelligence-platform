/**
 * Shared Workflow vocabulary (WORKFLOW-WF-2B; Model §10, UX §8.3, IA §12). Pure, closed vocabularies only, shared by the
 * workflow module (the owner of the state) and the audit ledger (which records its changes). The SQL migration 0034 is
 * the source of truth for the stored values; these lists are pinned against it by test.
 */

/** Model §10.1: Open and Done only (no Waiting or Snoozed, UX-05). */
export const WORK_ITEM_STATES = ["OPEN", "DONE"] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** UX §8.3 / Model §10: recorded when Done, where applicable. Optional. */
export const WORK_ITEM_RESOLUTIONS = [
  "replied_publicly",
  "replied_privately",
  "replied_on_platform",
  "no_reply_needed",
  "moderated",
  "reviewed",
  "escalation_closed",
] as const;
export type WorkItemResolution = (typeof WORK_ITEM_RESOLUTIONS)[number];

export const isWorkItemState = (value: unknown): value is WorkItemState => typeof value === "string" && (WORK_ITEM_STATES as readonly string[]).includes(value);
export const isWorkItemResolution = (value: unknown): value is WorkItemResolution => typeof value === "string" && (WORK_ITEM_RESOLUTIONS as readonly string[]).includes(value);

/** A workflow state as the audit ledger summarizes it: the state and its resolution (only ever with DONE). */
export interface WorkflowStateSummary {
  readonly state: WorkItemState;
  readonly resolution: WorkItemResolution | null;
}
