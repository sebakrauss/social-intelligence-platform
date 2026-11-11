import { inject } from "vitest";
import { defineValidationIntegrationSuite } from "../suites/validation-integration";

defineValidationIntegrationSuite(() => inject("dbTarget"));
