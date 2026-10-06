import { inject } from "vitest";
import { defineConnectionsSuite } from "../suites/connections";

defineConnectionsSuite(() => inject("dbTarget"));
