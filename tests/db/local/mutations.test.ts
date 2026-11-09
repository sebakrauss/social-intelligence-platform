import { inject } from "vitest";
import { defineMutationsSuite } from "../suites/mutations";

defineMutationsSuite(() => inject("dbTarget"));
