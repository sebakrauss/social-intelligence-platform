import { inject } from "vitest";
import { defineCredentialRefreshSuite } from "../suites/credential-refresh";

defineCredentialRefreshSuite(() => inject("dbTarget"));
