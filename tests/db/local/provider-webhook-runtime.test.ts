import { inject } from "vitest";
import { defineProviderWebhookRuntimeSuite } from "../suites/provider-webhook-runtime";

defineProviderWebhookRuntimeSuite(() => inject("dbTarget"));
