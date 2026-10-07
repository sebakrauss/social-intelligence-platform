import { inject } from "vitest";
import { defineCapabilitySuite } from "../suites/capability";

defineCapabilitySuite(() => inject("dbTarget"));
