import { inject } from "vitest";
import { defineSignalProgressPersistenceSuite } from "../suites/signal-progress-persistence";

defineSignalProgressPersistenceSuite(() => inject("dbTarget"));
