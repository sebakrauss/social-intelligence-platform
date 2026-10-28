import { inject } from "vitest";
import { defineProviderSignalProcessingSuite } from "../suites/provider-signal-processing";

defineProviderSignalProcessingSuite(() => inject("dbTarget"));
