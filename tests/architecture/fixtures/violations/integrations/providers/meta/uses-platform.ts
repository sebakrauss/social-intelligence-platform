/** Violation: the Meta adapter never imports platform modules (DB, KMS, jobs, observability). */
import * as jobs from "../../../platform/jobs/port";
export const leaked = jobs;
