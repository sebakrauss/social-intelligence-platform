import { inject } from "vitest";
import { defineCapabilityReevaluationSuite } from "../suites/capability-reevaluation";

defineCapabilityReevaluationSuite(() => inject("dbTarget"));
