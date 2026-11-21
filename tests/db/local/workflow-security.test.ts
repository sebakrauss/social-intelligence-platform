import { inject } from "vitest";
import { defineWorkflowSecuritySuite } from "../suites/workflow-security";

defineWorkflowSecuritySuite(() => inject("dbTarget"));
