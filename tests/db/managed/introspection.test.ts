import { inject } from "vitest";
import { defineIntrospectionSuite } from "../suites/introspection";

defineIntrospectionSuite(() => inject("dbTarget"));
