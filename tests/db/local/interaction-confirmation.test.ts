import { inject } from "vitest";
import { defineInteractionConfirmationSuite } from "../suites/interaction-confirmation";

defineInteractionConfirmationSuite(() => inject("dbTarget"));
