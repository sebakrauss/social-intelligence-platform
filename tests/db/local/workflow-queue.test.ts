import { inject } from "vitest";
import { defineWorkflowQueueSuite } from "../suites/workflow-queue";

defineWorkflowQueueSuite(() => inject("dbTarget"));
