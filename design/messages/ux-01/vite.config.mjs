// MESSAGES-UX-01 — isolated preview server for the synthetic Messages prototype (design only; not part of the app).
// Run from the repository root:  npx vite --config design/messages/ux-01/vite.config.mjs
// It serves on http://localhost:3101 (never 3000), resolves "@/…" to the repository root so the prototype can reuse
// Wrenkind's real tokens, fonts, icons and primitives read-only, and keeps Vite's cache outside the repository.
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

export default {
  root: here,
  cacheDir: join(tmpdir(), "wrenkind-messages-ux-01-vite"),
  appType: "spa",
  resolve: { alias: { "@": repo } },
  server: { host: "localhost", port: 3101, strictPort: true, fs: { allow: [repo] } },
  preview: { host: "localhost", port: 3101, strictPort: true },
  clearScreen: false,
};
