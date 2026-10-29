import { inject } from "vitest";
import { defineClassificationPersistenceSuite } from "../suites/classification-persistence";

defineClassificationPersistenceSuite(() => inject("dbTarget"));
