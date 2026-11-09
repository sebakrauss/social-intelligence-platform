import { inject } from "vitest";
import { defineInboxReadSuite } from "../suites/inbox-read";

defineInboxReadSuite(() => inject("dbTarget"));
