import { inject } from "vitest";
import { defineWorkflowAcceptanceFixtureSuite } from "../suites/workflow-acceptance-fixture";

defineWorkflowAcceptanceFixtureSuite(() => inject("dbTarget"));
