import { defineConfig } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  ssr: false,
  server: {
    preset: "static",
    prerender: { crawlLinks: false, routes: [] },
  },
  vite: {
    plugins: [
      tailwindcss(),
      VitePWA({
        // Prompt the user before activating the new SW — we surface a
        // toast in <UpdateToast /> that calls updateSW() on tap. See
        // virtual:pwa-register usage in src/components/UpdateToast.tsx.
        registerType: "prompt",
        injectRegister: false,
        devOptions: { enabled: true, type: "module" },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
          navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        },
        includeAssets: ["favicon.svg", "icon-192.svg", "icon-512.svg"],
        manifest: {
          name: "Work Station",
          short_name: "WorkStation",
          description:
            "Companion PWA for Work Station — remote terminal, tasks, and system monitor.",
          theme_color: "#0a0a0a",
          background_color: "#0a0a0a",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          scope: "/",
          icons: [
            {
              src: "/icon-192.svg",
              sizes: "192x192",
              type: "image/svg+xml",
              purpose: "any",
            },
            {
              src: "/icon-512.svg",
              sizes: "512x512",
              type: "image/svg+xml",
              purpose: "any maskable",
            },
          ],
        },
      }),
    ],
  },
});
