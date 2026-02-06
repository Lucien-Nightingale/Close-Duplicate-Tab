export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: ["dist/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        chrome: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "args": "none" }],
      "eqeqeq": "warn"
    }
  }
];
