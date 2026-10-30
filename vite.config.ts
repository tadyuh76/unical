import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Popup, background worker and its hidden reading page. The content script is built separately
// (vite.content.config.ts) because it must be a single classic script.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "build",
    rollupOptions: {
      input: {
        main: "index.html",
        offscreen: "offscreen.html",
        background: "src/background.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
