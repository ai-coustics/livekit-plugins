import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  external: ["@ai-coustics/aic-sdk", "@livekit/rtc-node"],
  format: ["esm", "cjs"],
  sourcemap: true,
  splitting: false,
});

