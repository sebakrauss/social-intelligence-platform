import { inject } from "vitest";
import { defineHostedWebSuite } from "../suites/hosted-web";

defineHostedWebSuite(() => inject("dbTarget"));
