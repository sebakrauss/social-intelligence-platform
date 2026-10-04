// DISPOSABLE SPIKE — loads ../.env.local and normalizes the bootstrap URL IN MEMORY ONLY (never written back):
// the dashboard template's literal "[...]" around the password is stripped if present.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local'));
const raw = process.env.SUPABASE_DB_BOOTSTRAP_URL;
const m = raw.match(/^(postgres(?:ql)?:\/\/[^:]+:)\[(.*)\](@[^@]+)$/);
export const bootstrapUrlWasBracketed = Boolean(m);
if (m) process.env.SUPABASE_DB_BOOTSTRAP_URL = m[1] + m[2] + m[3];
