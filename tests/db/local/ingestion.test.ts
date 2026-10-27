import { inject } from "vitest";
import { defineIngestionSuite } from "../suites/ingestion";

defineIngestionSuite(() => inject("dbTarget"));
