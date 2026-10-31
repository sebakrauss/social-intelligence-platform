import { inject } from "vitest";
import { defineIntelligencePersistenceSuite } from "../suites/intelligence-persistence";

defineIntelligencePersistenceSuite(() => inject("dbTarget"));
