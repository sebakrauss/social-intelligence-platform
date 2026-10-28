import { inject } from "vitest";
import { defineOutboxMemberTopicsSuite } from "../suites/outbox-member-topics";

defineOutboxMemberTopicsSuite(() => inject("dbTarget"));
