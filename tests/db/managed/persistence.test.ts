import { inject } from "vitest";
import { definePersistenceSuite } from "../suites/persistence";

definePersistenceSuite(() => inject("dbTarget"));
