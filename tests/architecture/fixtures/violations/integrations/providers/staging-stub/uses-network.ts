// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { request } from "node:http";
export const reachesNetwork: unknown = request;
