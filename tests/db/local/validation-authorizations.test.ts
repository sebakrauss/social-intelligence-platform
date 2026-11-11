import { inject } from "vitest";
import { defineValidationAuthorizationsSuite } from "../suites/validation-authorizations";

defineValidationAuthorizationsSuite(() => inject("dbTarget"));
