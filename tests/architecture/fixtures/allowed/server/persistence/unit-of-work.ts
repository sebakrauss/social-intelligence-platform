// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed: server composes module persistence with platform/db.
import { byId } from "../../modules/tenancy/persistence/store";

export const unitOfWork = byId;