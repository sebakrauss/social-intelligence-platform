import { inject } from "vitest";
import { defineMetaReconnectSuite } from "../suites/meta-reconnect";

defineMetaReconnectSuite(() => inject("dbTarget"));
