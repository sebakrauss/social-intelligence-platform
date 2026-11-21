import { inject } from "vitest";
import { defineWorkflowIngestionSuite } from "../suites/workflow-ingestion";

defineWorkflowIngestionSuite(() => inject("dbTarget"));
