import { inject } from "vitest";
import { defineMetaRemoveSuite } from "../suites/meta-remove";

defineMetaRemoveSuite(() => inject("dbTarget"));
