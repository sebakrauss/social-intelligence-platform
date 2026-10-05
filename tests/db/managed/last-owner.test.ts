import { inject } from "vitest";
import { defineLastOwnerConcurrencySuite } from "../suites/last-owner";

defineLastOwnerConcurrencySuite(() => inject("dbTarget"));
