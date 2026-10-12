# Tydora 优化评审 — 2026-09-23

- **评审范围**：构建产物 / 首屏加载、安装包体积、仓库卫生、质量门禁、可维护性
- **方法**：读取实际构建产物做静态依赖闭包分析 + 源码引用链核对；不猜测，所有数字均为本次实测
- **被测版本**：0.3.1（含同日两轮缺陷修复）
- **配套工具**：`npm run analyze:bundle`（`scripts/check-eager-bundle.mjs`，本次新增）

结论先说：**功能层面没发现新的明显缺陷；真正的优化空间在「质量门禁」和「首屏体积」两块**。前者几乎零成本、杠杆最大；后者有约 5.5 MB 的确定性收益。

---

## 一、首屏加载：6.49 MB 必须解析

`npm run analyze:bundle` 实测输出：

| 分类 | 体积 | 内容 |
|---|---|---|
| [A] 静态 import 闭包 | **3,522 kB** | lowlight-vendor 1130 / codemirror-vendor 851 / tiptap-vendor 589 / katex-vendor 521 / 入口 400 / tauri-vendor 31 |
| [B] 额外 modulepreload | **3,128 kB** | mermaid-vendor |
| **首屏代价合计** | **6,650 kB（6.49 MB）** | 对照：全部 JS 产物 10.41 MB，即只有 3.92 MB 被正确懒加载 |

### 关键发现：已有的懒加载边界被 `manualChunks` 穿透了

`App.tsx` **已经**对编辑器做了懒加载：

```ts
const Editor = lazy(() => import("./Editor/TipTapEditor")…);
const CodeMirrorEditor = lazy(() => import("./Editor/CodeMirrorEditor")…);
const TerminalView = lazy(() => import("./Terminal/TerminalView")…);
```

但实际产物里，入口 chunk 的静态 import 是：

```
index-Dw-_lwXc.js  →  tiptap-vendor
                      lowlight-vendor
                      tauri-vendor
tiptap-vendor      →  katex-vendor
                      codemirror-vendor
                      lowlight-vendor
```

**机制**：`vite.config.ts` 的 `manualChunks` 按**包名**分组（`id.includes("@tiptap")` → `tiptap-vendor` 等）。按包名分组意味着「整包同生共死」——只要入口的静态依赖图碰到包内**任意一个**模块，整个包的 chunk 就必须在首屏加载；而 `tiptap-vendor` 又静态依赖 `katex-vendor` 和 `codemirror-vendor`，于是 4 个重型库被串成一条**必须加载的链**，把 `lazy()` 的意图抵消掉了。

而这几块的**实际用途都是条件性的**：

| 库 | 首屏代价 | 什么时候才真正需要 |
|---|---|---|
| mermaid | 3,128 kB | 笔记里有 mermaid 代码块时 |
| lowlight（`common`，37 种语言） | 1,130 kB | 笔记里有代码块时（且只需其中几种语言） |
| codemirror | 851 kB | 切到 SV 源码模式时 |
| katex | 521 kB | 笔记里有数学公式时 |

### 建议（按收益/成本排序）

1. **mermaid 改动态 import** — 收益 **3.13 MB**
   `Editor/extensions/mermaid.ts:3` 是 `import mermaid from "mermaid"`，但真正的初始化已经是懒调用（`ensureMermaid()` + `mermaidReady` 标志）。只需把顶层 import 改成函数内 `const { default: mermaid } = await import("mermaid")`，调用方 await 一下即可。**改动最小、收益最大的一条。**

2. **重做 `manualChunks`** — 收益 **1.4 MB 以上**
   删掉按包名的强制分组（交回 Rollup 按实际使用切分），或仅保留真正被入口与懒路由共享的 vendor。改完务必用 `npm run analyze:bundle` 复核——这个工具就是为验证这条而写的。

3. **`lowlight` 的 `common` 移到动态 import** — 收益 **约 1.0 MB**
   现状 `TipTapEditor.tsx:32` 静态引 `common`，并在模块顶层 `createLowlight(common)`（第 289 行）。项目**已经有**成熟做法：第 296 行「首帧渲染后异步注册 14 种额外语言」。把 `common` 并入同一批动态注册即可（代价：代码块先无高亮，几十毫秒后自动补上，与现有额外语言的行为一致）。

4. **katex 改动态 import** — 收益 **约 0.52 MB**
   `MathDialog.tsx` 与 `WikiLinkPreview.tsx` 都静态引 katex，且都是「用到才出现」的 UI。`katex.min.css` 也可随之一并懒加载（KaTeX 的 `@font-face` 只在公式元素实际渲染时才触发字体下载）。

5. **codemirror 改按需加载** — 收益 **约 0.85 MB**
   `CodeMirrorEditor` 在 `App.tsx` 已是 `lazy()`，但被 `TipTapEditor.tsx:54` 静态引回。可改为切到 SV 模式时再 `import()`。

> 以上 5 条全部落地，首屏可从 6.49 MB 降到 **约 1.0 MB**（仅剩入口 + tiptap 核心 + tauri）。
> 验证方式：`npm run analyze:bundle --budget=2`（已支持预算门禁，超限退出码 1，可直接接进 CI）。
> 量化启动收益：项目已有 `boot-timing.ts`（`window.__TYDORA_BOOT__` + Rust `boot-timing` 事件），优化前后各跑一次即可，无需另造轮子。

---

## 二、安装包体积

| 项 | 现状 | 建议 |
|---|---|---|
| KaTeX 字体 | **1.02 MB**：ttf 20 个（0.49 MB）+ woff 20 个（0.29 MB）+ woff2 19 个（0.24 MB） | 只保留 woff2。KaTeX 的 CSS 把 woff2 排在 `src` 第一位，运行时**永远不会**下 ttf/woff —— 它们纯粹是安装包里的死重。构建后清理即可，收益 **0.78 MB**（约为 8.65 MB NSIS 安装包的 9%）。Windows WebView2 / macOS WKWebView / Linux WebKitGTK 均支持 woff2。 |
| Rust release profile | 已调优：`lto="thin"` + `codegen-units=1` + `strip="symbols"` + `opt-level="z"` | 可再做实验：`lto="fat"`（更小、编译更慢）；`panic="abort"` 还能省一点，但需确认没有依赖 `catch_unwind` 的路径。**优先级低**，现有配置已经到位。 |

---

## 三、仓库卫生

| 项 | 实测 | 建议 |
|---|---|---|
| 文档图片 | `website/` 下 **25 个 PNG 共 30.4 MB**（单张最大 4.5 MB），占已跟踪内容 40.7 MB 的 **75%**；`.git` 已达 78 MB | 截图转 WebP/AVIF（同类图片通常省 60–85%），或新图走 Git LFS。需同步改 15 处文档引用。注意：重写历史影响所有协作者，建议只对**新增**图片生效。 |
| license 不一致 | `app/Cargo.toml:17` 是 `license = "MIT"`，仓库 `LICENSE` 是 **Apache-2.0**；三个 crate 都 `license.workspace = true`，会一起错 | 改一行（若采用 Apache-2.0）。上一轮已记录，至今未修。 |
| 已确认**不是**问题 | `vendor/markdown-publish` 本地 87 MB，但被跟踪的只有 1.8 MB（其 `node_modules` 未入库）；`dsh/`、`cordis.patch.yml` 是 DSH 插件的有意设计 | 无需处理 |

---

## 四、质量门禁（最高杠杆，成本最低）

这是本次评审**最重要的发现**：

| 现状 | 证据 |
|---|---|
| **没有任何 CI 跑测试** | `.github/workflows/` 4 个 workflow（deploy-docs / msstore / release-please / release）里，`cargo test` / `tsc` / 单测的出现次数均为 **0**，且没有一个在 `pull_request` 上触发 |
| **没有 `npm test`** | `package.json` 里只有 `cli:test`；`CLAUDE.md:65` 也写明「项目没有 test / eslint / prettier 脚本」 |
| **149 条前端断言只能手工跑** | 6 个测试文件散落各处，每条都得 `node --experimental-strip-types <file>` |
| **没有 lint** | 无 eslint / prettier / biome 配置 |

**代价已经显现**：同日两轮排查共修 **17 个缺陷**（3 个 P0，含 1 个数据损坏级），全部靠人工代码审查 + 手工实测发现，自动化门禁一个都没拦住。其中至少 2 类缺陷本可被自动发现：

- **i18n 各缺 1 个 key**（BUG-15）、**三份围栏正则不一致**（BUG-20）→ 一条「一致性比对测试」即可拦住
- **源码模式读到过期内容**（BUG-05/06 根因是闭包读到了过期的 `mode`）→ `eslint-plugin-react-hooks` 的 `exhaustive-deps` 有很大概率提前报警

### 建议（三步，约半天）

1. **给前端加统一测试入口**（约 1 小时）
   加 `scripts/run-tests.mjs`：扫描 `app/tydora-web/src/**/*.test.ts` 逐个 `node --experimental-strip-types` 跑，汇总断言数与失败数，失败时退出码 1；挂到 `"test": "node scripts/run-tests.mjs"`。
   （没有入口，CI 就无从挂载 —— 这是后续两步的前提。）

2. **加 CI 工作流**（约 1 小时，约 30 行 YAML）
   `.github/workflows/ci.yml`，`on: [pull_request, push: branches: [main]]`，跑：
   `node node_modules/typescript/bin/tsc --noEmit` → `npm test` → `cargo test -p tydora-core -p tydora-cli` → `cargo check -p tydora-desktop` →（构建后）`npm run analyze:bundle --budget=<当前值>`

3. **补两条「一致性」回归测试**（约 2 小时）
   - i18n：拍平两份 locale JSON 成 Set，正则扫源码 `t("…")` 字面量做双向比对（注意排除 `themes/*.ts`、`export/xiaohongshu/fonts.ts` 里被当作变量名的 `t(`）。上一轮的手工脚本思路已验证可行。
   - 可选：开启 `eslint` + 仅 `react-hooks` 两条规则，先不做全量 lint，避免噪声淹没信号。

---

## 五、可维护性

### 巨型文件与缺陷分布

| 文件 | 行数 |
|---|---|
| `App.tsx` | 4,798 |
| `Sidebar.tsx` | 4,113 |
| `Settings.tsx` | 3,524 |
| `Editor/TipTapEditor.tsx` | 2,858 |

前端合计 190 个文件 / 52,623 行。

**值得注意的相关性**：17 个已修缺陷里有 3 个正好落在这 4 个文件中的 3 个 —— 源码模式守卫（`App.tsx`）、跨窗口设置覆盖写（`Settings.tsx`）、SV 模式下 `getValue` 未转发（`TipTapEditor.tsx`）。共同点是「跨模式 / 跨窗口的不变量需要在多个位置保持一致」，而 3000+ 行的组件让这种一致性难以维持。

建议按「窗口 / 面板」粒度拆分，优先 `Settings.tsx`（已天然按分区组织，拆分只是搬文件 + 抽 section 组件）。

### 其它

- `mindmap/MindmapView.tsx` 有 4 条 `[MindmapCopy]` 调试日志（第 610/656/683/696 行），建议收敛到一个统一开关，避免发布版往控制台刷噪声。
- i18n 1100+ key × 2 份靠人工同步，建议并入第四节第 3 步的常驻测试。

---

## 六、已经做得好的部分（不建议动）

- `tsconfig.json` 已开 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`
- Rust `[profile.release]` 已是体积优先的合理配置
- `boot-timing.ts` 有完整的启动计时设施（console.time + performance.mark + `__TYDORA_BOOT__` + Rust 事件对齐），可直接用于量化启动优化
- `App.tsx` 的多窗口 `lazy()` 拆分方向是对的（问题只在 `manualChunks` 抵消了它）
- 导出链路（`export/index.ts`）已经用 `await import` 按需加载 exporters / docx

---

## 七、建议执行顺序

| 顺序 | 项 | 预期收益 | 成本 |
|---|---|---|---|
| 1 | 前端统一测试入口 + CI 工作流 | 阻断回归（已知 17 缺陷全漏） | 半天内 |
| 2 | mermaid 动态 import | 首屏 −3.13 MB | 十几行 |
| 3 | 重做 `manualChunks` | 首屏 −1.4 MB 起 | 十几行 + 复核 |
| 4 | lowlight `common` / katex / codemirror 按需 | 首屏 −2.4 MB | 半天内 |
| 5 | KaTeX 只留 woff2 | 安装包 −0.78 MB | 构建脚本几行 |
| 6 | `Cargo.toml` license 改一行 | 元数据正确性 | 1 分钟 |
| 7 | 文档图片转 WebP | 仓库 −20 MB 以上 | 需改 15 处引用 |
| 8 | 巨型文件拆分 / 收敛调试日志 | 长期可维护性 | 渐进 |

第 2~5 条做完，首屏应从 6.49 MB 降到约 1.0 MB，安装包再减约 0.78 MB。
