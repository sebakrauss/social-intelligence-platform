// One lint configuration for TypeScript, React and the App Router code.
// Architectural boundaries are enforced separately by dependency-cruiser (`npm run boundaries`).
// eslint-config-next is intentionally not used: its plugin chain carries an unresolved high-severity
// advisory (GHSA-vfj7-8cjw-p6xm, braces). Revisit when upstream ships a fix.
import { defineConfig, globalIgnores } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "coverage/**",
    "node_modules/**",
    "spikes/**",
    "docs/**",
    "next-env.d.ts",
    "tests/architecture/fixtures/**",
  ]),

  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },

  {
    files: ["**/*.tsx"],
    extends: [react.configs.flat.recommended, react.configs.flat["jsx-runtime"], reactHooks.configs.flat.recommended],
    settings: { react: { version: "detect" } },
    rules: {
      // External content (comments, names, AI output) is rendered as text only (TA §38.7).
      "react/no-danger": "error",
    },
  },

  {
    // The stdout sink and repository tooling are the only places allowed to write to the console.
    files: ["platform/observability/sinks.ts", "tools/**/*.ts"],
    rules: { "no-console": "off" },
  },

  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
