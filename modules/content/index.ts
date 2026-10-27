/**
 * content module public API (TA §7.1, L1). Step H6-B: canonical content items exist only as ingestion writes them
 * (the store port below, implemented by content/persistence); no content commands or views yet.
 */
export type { ContentItemRecord, ContentItemStore, NewContentItem } from "./application/ports";
