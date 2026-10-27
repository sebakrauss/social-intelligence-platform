import { inject } from "vitest";
import { defineAuditProvenanceSuite } from "../suites/audit-provenance";

defineAuditProvenanceSuite(() => inject("dbTarget"));
