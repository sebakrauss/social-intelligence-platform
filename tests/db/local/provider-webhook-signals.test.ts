import { inject } from "vitest";
import { defineProviderWebhookSignalsSuite } from "../suites/provider-webhook-signals";

defineProviderWebhookSignalsSuite(() => inject("dbTarget"));
