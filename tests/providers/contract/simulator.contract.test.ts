/**
 * The provider contract suites, run against the simulator (Step 4 exit criterion: contract tests pass for the
 * simulator). The authorization suite (Step 5C) runs once per PKCE mode. Real adapters will add their own
 * `*.contract.test.ts` with a harness over recorded fixtures.
 */
import { PKCE_SUPPORT } from "@/integrations/providers/contract";
import { simulatorAuthorizationHarness, simulatorContractHarness } from "../support/simulator-harness";
import { defineAuthorizationContractSuite } from "./authorization-contract";
import { defineProviderContractSuite } from "./provider-contract";

defineProviderContractSuite(simulatorContractHarness);

for (const mode of PKCE_SUPPORT) defineAuthorizationContractSuite(simulatorAuthorizationHarness(mode));
