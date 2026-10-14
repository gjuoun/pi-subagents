import { defineConfig } from "vitest/config";

export default defineConfig({
  // The faux-model e2e tests (test/helpers/v2-runner.ts) drive REAL turns through
  // pi-coding-agent + pi-agent-core. That needs ONE shared @earendil-works/pi-ai instance
  // so the faux provider a test registers lands in the registry the session streams
  // through. npm can duplicate pi-ai; inlining the @earendil-works packages routes them
  // through Vite's resolver so dedupe collapses pi-ai to a single instance — for the
  // parent AND every subagent session the extension spawns.
  test: {
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    // istanbul, not v8: a real pi session re-loads the extension, and v8 merges the two
    // copies of a file badly; istanbul accumulates per source path.
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
