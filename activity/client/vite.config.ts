import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [ngp({
    typeChecker: 'tsrs',
    typeCheck: true,
  })],
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
