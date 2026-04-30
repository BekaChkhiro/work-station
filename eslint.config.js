import js from "@eslint/js";
import ts from "typescript-eslint";
import solid from "eslint-plugin-solid";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/target/**", "src-tauri/gen/**"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  solid.configs["flat/typescript"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  prettier,
];
