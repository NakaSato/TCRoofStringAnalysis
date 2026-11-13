import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable PWA. The service worker precaches the app's own static build only: `/api/**`
    // is never cached or served offline (live values must never be stored in the browser), and
    // no runtime caching is configured, so API calls always go to the network.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "TC Roof · GenZ Monitoring System",
        short_name: "GenZ Monitoring",
        description: "PV string performance and O&M for the TC Renewable rooftop fleet",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#05080f",
        theme_color: "#05080f",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        // the main chunk is ~0.6 MB; leave headroom so it is precached
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
