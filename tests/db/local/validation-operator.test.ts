import { inject } from "vitest";
import { defineValidationOperatorSuite } from "../suites/validation-operator";

defineValidationOperatorSuite(() => inject("dbTarget"));
