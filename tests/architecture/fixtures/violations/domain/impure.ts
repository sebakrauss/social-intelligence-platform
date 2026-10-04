// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { db } from "../platform/db/client";
import type { NextConfig } from "next";
export const leak: [typeof db, NextConfig | undefined] = [db, undefined];
