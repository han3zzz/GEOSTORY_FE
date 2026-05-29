import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    // Tự động polyfill Buffer, process, global... cho toàn bộ bundle
    // Đây là cách duy nhất chắc chắn fix "Buffer is not defined" khi SDK
    // dùng Buffer ngay lúc module được parse (trước khi code của mình chạy)
    nodePolyfills({
      include: ["buffer", "process", "util"],
      globals: {
        Buffer: true,      // inject `import { Buffer } from 'buffer'` vào mọi file
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});