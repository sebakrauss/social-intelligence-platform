import { inject } from "vitest";
import { defineConnectionLifecycleSuite } from "../suites/connection-lifecycle";

defineConnectionLifecycleSuite(() => inject("dbTarget"));
