import { inject } from "vitest";
import { defineT27Suite } from "../suites/t27";

defineT27Suite(() => inject("dbTarget"));
