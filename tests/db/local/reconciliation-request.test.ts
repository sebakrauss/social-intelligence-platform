import { inject } from "vitest";
import { defineReconciliationRequestSuite } from "../suites/reconciliation-request";

defineReconciliationRequestSuite(() => inject("dbTarget"));
