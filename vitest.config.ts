import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@happy/contracts": fromRoot("./packages/contracts/src/index.ts"),
      "@happy/core": fromRoot("./packages/core/src/index.ts"),
      "@happy/runtime": fromRoot("./packages/runtime/src/index.ts")
    }
  },
  test: { include: ["tests/**/*.test.ts"] }
});
