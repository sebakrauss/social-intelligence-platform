import { inject } from "vitest";
import { defineClassificationRuntimeSuite } from "../suites/classification-runtime";

defineClassificationRuntimeSuite(() => inject("dbTarget"));
