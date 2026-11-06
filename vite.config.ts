import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  build: {
    rollupOptions: {
      // Default is 1000 parallel file operations. Cloudflare Builds can hit
      // EMFILE while Rollup scans lucide-react's large icon export graph.
      // A bounded limit works for both the Worker and the React client build.
      maxParallelFileOps: 32,
    },
  },
  plugins: [react(), tailwind(), cloudflare({ configPath: "./wrangler.generated.jsonc", viteEnvironment: { name: "worker" } })],
});
