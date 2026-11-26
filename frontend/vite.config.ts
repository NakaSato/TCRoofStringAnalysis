import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";

// The camera scanner needs https on a real phone / iPad: `VITE_DEV_HTTPS=1 bun run dev --host`
// serves the dev server with a self-signed certificate on the LAN (dev only; accept it once on the device).
const devHttps = process.env.VITE_DEV_HTTPS === "1";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(devHttps ? [basicSsl()] : []),
    // Installable PWA. The service worker precaches the app's own static build only: `/api/**`
    // is never cached or served offline (live values must never be stored in the browser), and
    // the only runtime caching is map imagery (see `runtimeCaching`), so API calls always go to the network.
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
        // `.wasm` = the barcode decoder (zxing, ~1 MB), so camera scanning works in the installed app offline
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,wasm}"],
        // the push service worker (public/firebase-messaging-sw.js) is registered on its own scope
        globIgnores: ["**/node_modules/**/*", "firebase-messaging-sw.js"],
        // the main chunk is ~0.6 MB; leave headroom so it is precached
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // Map imagery only (static pictures of the ground, no plant data): basemap / satellite
        // tiles and the plant directory's roof thumbnails. Loaded with CORS (`crossOrigin`) so the
        // responses are not opaque. Longdo / RainViewer radar tiles are left to the HTTP cache:
        // they are live snapshots and carry the Longdo key.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /(^|\.)arcgisonline\.com$/.test(url.hostname) && url.pathname.includes("/MapServer/"),
            handler: "CacheFirst",
            options: {
              cacheName: "map-esri",
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === "api.mapbox.com" && url.pathname.startsWith("/styles/v1/") && url.pathname.includes("/tiles/"),
            handler: "CacheFirst",
            options: {
              cacheName: "map-mapbox",
              expiration: { maxEntries: 1500, maxAgeSeconds: 7 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
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
