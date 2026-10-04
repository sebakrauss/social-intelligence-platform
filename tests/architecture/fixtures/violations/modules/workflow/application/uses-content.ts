// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { contentApi } from "../../content/index";
import { db } from "../../../platform/db/client";
export const value = [contentApi, db];
