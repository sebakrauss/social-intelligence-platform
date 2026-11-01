import { inject } from "vitest";
import { defineIntelligenceRuntimeSuite } from "../suites/intelligence-runtime";

defineIntelligenceRuntimeSuite(() => inject("dbTarget"));
