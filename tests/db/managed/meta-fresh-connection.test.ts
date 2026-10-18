import { inject } from "vitest";
import { defineMetaFreshConnectionSuite } from "../suites/meta-fresh-connection";

defineMetaFreshConnectionSuite(() => inject("dbTarget"));
