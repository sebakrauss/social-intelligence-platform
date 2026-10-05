/**
 * The provider contract suite, run against the simulator (Step 4 exit criterion: contract tests pass for the
 * simulator). Real adapters will add their own `*.contract.test.ts` with a harness over recorded fixtures.
 */
import { simulatorContractHarness } from "../support/simulator-harness";
import { defineProviderContractSuite } from "./provider-contract";

defineProviderContractSuite(simulatorContractHarness);
