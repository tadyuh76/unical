import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "build",
    emptyOutDir: false,
    lib: {
      entry: "src/content.ts",
      formats: ["iife"],
      name: "unical",
      fileName: () => "content.js",
    },
  },
});
