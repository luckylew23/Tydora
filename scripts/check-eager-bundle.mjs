#!/usr/bin/env node
/**
 * 首屏加载代价检查（bundle eager cost）。
 *
 * 为什么需要这个工具：
 *   应用已经用 `lazy()` 把编辑器 / 各窗口切成了懒加载 chunk，但 `vite.config.ts`
 *   里按**包名**分组的 `manualChunks` 会把整包塞进一个 chunk —— 只要入口的静态
 *   依赖图碰到包里任一模块，整个包就变成首屏必须加载的，懒加载边界被穿透。
 *   产物体积表看不出这件事（chunk 都在），必须算**静态闭包**才知道首屏到底要
 *   下载并编译多少。详见 docs/optimization-review-2026-09-23.md。
 *
 * 统计口径：
 *   [A] 静态 import 闭包 —— 入口 chunk 直接/传递 `import ... from "./x.js"` 得到的
 *       全部 chunk。首屏执行前必须就绪。
 *   [B] 额外 modulepreload —— 入口 HTML 用 `<link rel="modulepreload">` 声明的、
 *       不在 [A] 里的 chunk。modulepreload 的语义是 fetch **并编译**，同样计入首屏。
 *
 * 用法：
 *   node scripts/check-eager-bundle.mjs                # 默认读 .build/web-dist
 *   node scripts/check-eager-bundle.mjs --budget=2     # 超过 2 MB 退出码 1
 *   node scripts/check-eager-bundle.mjs .build/web-dist
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const budgetArg = args.find((a) => a.startsWith("--budget="));
const budgetMb = budgetArg ? Number(budgetArg.split("=")[1]) : null;
const distDir = args.find((a) => !a.startsWith("--")) ?? ".build/web-dist";

const assetsDir = path.join(distDir, "assets");
const indexPath = path.join(distDir, "index.html");

if (!fs.existsSync(indexPath)) {
  console.error(`找不到 ${indexPath} —— 请先构建（npm run build）。`);
  process.exit(2);
}

const sizeOf = (file) => {
  try {
    return fs.statSync(path.join(assetsDir, file)).size;
  } catch {
    return 0;
  }
};
const fmt = (bytes) => `${(bytes / 1024).toFixed(0)} kB`.padStart(9);

const html = fs.readFileSync(indexPath, "utf8");

// 入口 chunk
const entryMatch = html.match(/<script[^>]+src="\/assets\/(index-[^"]+\.js)"/);
if (!entryMatch) {
  console.error("在 index.html 中找不到入口 chunk。");
  process.exit(2);
}
const entry = entryMatch[1];

// 静态 import / export ... from "./x.js"
const staticDeps = (file) => {
  let source;
  try {
    // 打包产物把 import 集中在文件头部；只扫前若干 KB 足够且更快
    source = fs.readFileSync(path.join(assetsDir, file), "utf8").slice(0, 16384);
  } catch {
    return [];
  }
  const found = new Set();
  const re = /(?:^|;)(?:import|export)[^;]{0,400}?from\s*"\.\/([^"]+)"/g;
  let m;
  while ((m = re.exec(source))) found.add(m[1]);
  return [...found];
};

const closure = new Set([entry]);
const queue = [entry];
while (queue.length) {
  const file = queue.pop();
  for (const dep of staticDeps(file)) {
    if (!closure.has(dep)) {
      closure.add(dep);
      queue.push(dep);
    }
  }
}

const preloaded = [...html.matchAll(/rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)].map(
  (m) => m[1],
);
const extraPreload = preloaded.filter((f) => !closure.has(f));

const staticTotal = [...closure].reduce((sum, f) => sum + sizeOf(f), 0);
const preloadTotal = extraPreload.reduce((sum, f) => sum + sizeOf(f), 0);
const total = staticTotal + preloadTotal;

// 全部产物与其中「条件性依赖」的对照
const allAssets = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
const allJsTotal = allAssets.reduce((sum, f) => sum + sizeOf(f), 0);

console.log(`入口 chunk：${entry}`);
console.log(`\n[A] 静态 import 闭包（首屏执行前必须就绪）`);
for (const f of [...closure].sort((a, b) => sizeOf(b) - sizeOf(a))) {
  console.log(`  ${fmt(sizeOf(f))}  ${f}`);
}
console.log(`  ${fmt(staticTotal)}  ── 小计（${closure.size} 个文件）`);

console.log(`\n[B] 额外 modulepreload（fetch + 编译，同样计入首屏）`);
if (extraPreload.length === 0) {
  console.log("  （无）");
}
for (const f of extraPreload.sort((a, b) => sizeOf(b) - sizeOf(a))) {
  console.log(`  ${fmt(sizeOf(f))}  ${f}`);
}
console.log(`  ${fmt(preloadTotal)}  ── 小计（${extraPreload.length} 个文件）`);

const mb = (bytes) => (bytes / 1048576).toFixed(2);
console.log(`\n首屏代价合计：${fmt(total)}（${mb(total)} MB）`);
console.log(`对照：全部 JS 产物 ${mb(allJsTotal)} MB（其中 ${mb(allJsTotal - total)} MB 已正确懒加载）`);

if (budgetMb !== null && total / 1048576 > budgetMb) {
  console.error(`\n✗ 超出预算：${mb(total)} MB > ${budgetMb} MB`);
  process.exit(1);
}
if (budgetMb !== null) {
  console.log(`\n✓ 未超预算（${mb(total)} MB ≤ ${budgetMb} MB）`);
}
