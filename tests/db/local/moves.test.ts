import { inject } from "vitest";
import { defineMovesSuite } from "../suites/moves";

defineMovesSuite(() => inject("dbTarget"));
