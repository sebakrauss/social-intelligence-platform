import { inject } from "vitest";
import { defineT26Suite } from "../suites/t26";

defineT26Suite(() => inject("dbTarget"));
