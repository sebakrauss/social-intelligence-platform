// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import type { AuthUser } from "../../../platform/auth/port";
import { handled } from "../../../server/handler";
export const used: [AuthUser | undefined, number] = [undefined, handled[0]];
