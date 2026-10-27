import { inject } from "vitest";
import { defineReconciliationPersistenceSuite } from "../suites/reconciliation-persistence";

defineReconciliationPersistenceSuite(() => inject("dbTarget"));
