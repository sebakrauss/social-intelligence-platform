import { inject } from "vitest";
import { defineManagedAccountsSuite } from "../suites/managed-accounts";

defineManagedAccountsSuite(() => inject("dbTarget"));
