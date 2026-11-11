import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 管理页由 FastAPI 静态托管在 /manage，故 base 设为 /manage/
export default defineConfig({
  base: "/manage/",
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
