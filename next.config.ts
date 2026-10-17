import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Let phones on the same Wi-Fi and HTTPS tunnels (for installing the PWA) reach `next dev`.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "*.local", "*.trycloudflare.com", "*.ngrok-free.app", "*.ngrok.app"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
