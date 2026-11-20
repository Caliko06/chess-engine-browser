import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": [
        "error",
        { "name": "fetch", "message": "Production frontend runtime network calls are forbidden." },
        { "name": "XMLHttpRequest", "message": "Production frontend runtime network calls are forbidden." },
        { "name": "WebSocket", "message": "Production frontend runtime network calls are forbidden." },
        { "name": "EventSource", "message": "Production frontend runtime network calls are forbidden." }
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            "node:http",
            "node:https",
            "node:http2",
            "node:net",
            "node:tls",
            "node:dns",
            "node:dgram",
            "http",
            "https",
            "http2",
            "net",
            "tls",
            "dns",
            "dgram",
            "undici",
            "axios",
            "node-fetch"
          ]
        }
      ]
    }
  }
);
