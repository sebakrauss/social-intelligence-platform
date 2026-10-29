import { inject } from "vitest";
import { defineDevFixtureClassificationAcceptanceSuite } from "../suites/dev-fixture-classification-acceptance";

defineDevFixtureClassificationAcceptanceSuite(() => inject("dbTarget"));
