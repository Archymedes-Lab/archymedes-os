import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "out/**", "e2e-results/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  { files: ["e2e/**/*.mjs"], languageOptions: { globals: { URL: "readonly", process: "readonly" } } },
  {
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules, "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
);
