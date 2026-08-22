import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 鸿蒙打包专用构建配置：
//   vite build --config vite.hmos.config.ts --base=./
// 相对路径 base 适配 Web 组件加载 rawfile 资源。
// 注意：不要加 manualChunks 拆 vendor 包 —— @tiptap/prosemirror 与其余
// 依赖间存在跨 chunk 循环引用，会在运行时报 TDZ 错误导致白屏
// （"Cannot access '_' before initialization"）。默认分包已验证可用。

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
});
