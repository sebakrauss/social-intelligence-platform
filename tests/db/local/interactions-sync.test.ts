import { inject } from "vitest";
import { defineInteractionsSyncSuite } from "../suites/interactions-sync";

defineInteractionsSyncSuite(() => inject("dbTarget"));
