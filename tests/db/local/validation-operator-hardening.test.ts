import { inject } from "vitest";
import { defineValidationOperatorHardeningSuite } from "../suites/validation-operator-hardening";

defineValidationOperatorHardeningSuite(() => inject("dbTarget"));
