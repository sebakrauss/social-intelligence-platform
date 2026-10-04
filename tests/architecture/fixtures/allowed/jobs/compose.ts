// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { adapter } from "../integrations/providers/meta/adapter";
import { execute } from "../mutations/executor";
import { service } from "../server/service";
export const run = (): number => { execute(adapter); return service; };
