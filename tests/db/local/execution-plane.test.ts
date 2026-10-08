import { inject } from "vitest";
import { defineExecutionPlaneSuite } from "../suites/execution-plane";

defineExecutionPlaneSuite(() => inject("dbTarget"));
