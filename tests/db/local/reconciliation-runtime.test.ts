import { inject } from "vitest";
import { defineReconciliationRuntimeSuite } from "../suites/reconciliation-runtime";

defineReconciliationRuntimeSuite(() => inject("dbTarget"));
