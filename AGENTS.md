# AGENTS.md — Tydora Plus（tydora-plus 分支）agent 工作指南

> 面向在本仓库工作的 AI agent。Tydora 是基于 Tauri v2 + React 19 的 Markdown 编辑器（上游 zuorn/Tydora）；
> 本仓库 `tydora-plus` 分支是用户的个性化定制线，基于上游 0.3.3（`b8e9b51`）。

## 分支与同步

- **main**：跟随上游，当前仅领先 1 个提交 `aae3160`（编辑器文件切换修复，经用户确认 cherry-pick 进 main）。
- **tydora-plus**：个性化定制线，领先 main 9 个提交（打印导出 ×2、打印权限、AI 助手、CI 流水线 ×4、AI 代理修复、标题栏常显）。个人定制**只提交到此分支**；main 不回吸收定制（否则上游同步冲突成本高）。
- 同步上游：`git fetch upstream && git checkout main && git merge upstream/main`，再到 plus `git merge main`。上游改动触及 `App.tsx`/`Editor/`/locales 时需手动解冲突。
- ⚠️ gh 对 fork 默认解析到父仓库 zuorn：凡查/建本 fork 的 release/tag/pr，命令必须带 `-R luckylew23/Tydora`。

## 与上游的差异（特性清单）

1. **AI 助手**（对照移植 soloMD）：选区/全文范围的改写、精简、扩写、中英翻译、总结、解释、自定义指令；输出另存为新 md 文件。
2. **打印导出 PDF**：`export/pdfPrint/` 用系统打印对话框替代 html2canvas+jsPDF 位图导出。
3. **PDF/HTML 导出移除「创作于 Tydora」品牌角标**（保留文件名）。
4. **标题栏固定常显**：主窗口不自动隐藏（`autoHideTopbar`/`autoHideTopbarOnCollapse` 两设置在本分支不生效，设置窗口开关保留但无效）。
5. **编辑器修复**：文件切换被残留 `isInternalRef` 吞掉（标题已切新文件、内容停留上一篇）——上游 0.3.3 既有 bug，`TipTapEditor.tsx`/`CodeMirrorEditor.tsx` 同步 effect 改为 `fileChanged` 无条件优先。

## AI 助手架构

### Rust（`app/tydora-desktop/src/commands/ai_commands.rs`，7 命令）

`ai_rewrite`（流式代理，OpenAI 兼容 + Ollama 两种线格式）/ `ai_cancel`（协作式取消，`Arc<AtomicBool>`）/ `ai_set_key` / `ai_has_key` / `ai_clear_key`（keyring，async + spawn_blocking）/ `ai_verify_key` / `ai_list_models`（返回 `{ok, models, url, error}`，永不 Err）。

- 事件：`zmd-ai-chunk` / `zmd-ai-done` / `zmd-ai-error`（payload camelCase，按 requestId 过滤）。
- 密钥：OS keyring，service=`tydora`，slot=`ai-<provider>`；**永不进 localStorage、不打日志**。
- 注册于 `lib.rs`（import + generate_handler 两处都要加）。

### 前端（`app/tydora-web/src/ai/`）

| 文件 | 职责 |
|---|---|
| `providers.ts` | provider 目录（openai-compat / deepseek / ollama）+ 8 动作表（system/user 提示词、resultMode、saveSuffix） |
| `aiSettings.ts` | localStorage `zmd-ai-settings`（enabled/provider/models/baseUrls）；密钥永不入库 |
| `AIRewriteOverlay.tsx` | 双栏流式浮层：范围切换（选中文字/全文）、动作选择、接受/拒绝/重试/另存为 |
| `AISettingsContent.tsx` + `.css` | 设置页 AI 页签：Base URL → API Key（紧贴其下）→ 保存并验证 → 模型下拉 |
| `cleanAi.ts` | 清理 AI 格式标记（引用标记/零宽字符/智能引号），本地转换可撤销 |

### 交互模型（resultMode）

- `replace`（改写/精简/扩写）：覆盖选区或全文，经 `EditorHandle.replaceAt` / `replaceAllContent`，单步可撤销；原文列有删除线。
- `save`（中英翻译/总结/解释/自定义）：「另存为」把输出写入原文件目录的 `原文件名-后缀.md`（后缀：-翻译/-总结/-解释/-自定义），浮层内 `writeTextFile` 直写、失败就地显示不关浮层，成功派发 `zmd-ai-save` → App 打开新文件。原文列无删除线。
- 提示词全中文；system 角色硬性规则「输出语言跟随输入语言」（翻译按检测方向定向）。

### 提示词（改动作只改这里）

角色：`EDITOR_ROLE` / `TRANSLATOR_ROLE` / `EXPLAINER_ROLE`（providers.ts 顶部）。语言跟随规则写在 system；翻译的判向逻辑也写在 system（中文→英，其他→中）。

## 关键设计决策（为什么这么做）

| 决策 | 原因 |
|---|---|
| request_id 由前端预铸造再 invoke | 后端快速失败时事件早于 invoke 返回到达，监听器 requestId 为 null 会丢事件、浮层卡死（soloMD 实战教训） |
| keychain 命令 `async` + `spawn_blocking` | macOS 签名变更后首次读钥匙串弹授权框，同步命令冻结整窗 |
| 空密钥不发 `Authorization` 头 | llama-server 等对空 Bearer 报 401 |
| 回环目标（localhost/127.0.0.1）一律 `no_proxy` 直连 | reqwest 0.12.5+ 默认读 Windows 系统代理，Clash 类工具劫持本地请求（Windows "error sending request" 根因）；远程 provider 不受影响 |
| 网络错误展开完整 source 链（`error_chain`） | reqwest 顶层 Display 只有 "error sending request for url"，真实原因在 source 上 |
| 不发 `stream_options.include_usage` | 部分 vLLM 分叉直接 400 |
| `EditorHandle.replaceAllContent` 走用户编辑语义 | `setValue` 是外部同步语义（不回调 onChange），AI 替换结果会丢 |
| 版本 `0.3.3+N` 构建元数据 | semver 优先级与官方 0.3.3 相同，plus 用户不被自动更新提示覆盖回官版；`0.3.3a`/`0.3.3.1` 被 tauri/Cargo 拒绝 |

## 构建与发版

### 本机构建（macOS，全部实测过的坑）

```bash
# cargo 必须走 rsproxy 镜像（直连 crates.io 卡死）：临时 CARGO_HOME
mkdir -p /tmp/tydora-cargo-home && printf '[source.crates-io]\nreplace-with = "rsproxy-sparse"\n\n[source.rsproxy-sparse]\nregistry = "sparse+https://rsproxy.cn/index/"\n' > /tmp/tydora-cargo-home/config.toml
CARGO_HOME=/tmp/tydora-cargo-home npm run tauri build -- --config <覆盖文件>
```

- 覆盖文件内容：`{"version":"0.3.3+N","bundle":{"createUpdaterArtifacts":false}}`（本机无签名私钥；版本用构建元数据，应用内关于页显示后缀——`get_app_version` 优先读 `app.config().version`）。
- 前置：CLI sidecar 必须存在（`npm run build:cli` 或手动 cargo build 后双落位 `app/tydora-cli/binaries/<triple>/tydora-cli` + `app/tydora-desktop/binaries/tydora-cli-<triple>`），否则 tauri build script 报 externalBin 缺失。
- **DMG**：harness 无 GUI 会话时 tauri 的 `bundle_dmg.sh`（AppleScript）必失败（AppleEvent -1712）；改用纯 hdiutil——stage 目录放 `Tydora.app` + `Applications` 软链，`hdiutil create -volname Tydora -srcfolder stage -ov -format UDZO out.dmg`。
- **内联 JSON 传参会被剥引号**：`--config '{"a":1}'` 过 npm/npx 层后变成非法 JSON——一律写临时/仓库内配置文件再 `--config <path>`。
- 验证：`npx tsc --noEmit` + `cargo check`（mirror CARGO_HOME）。

### CI 发版（release-plus.yml，tydora-plus 专属）

- **触发**：push tag `v0.3.3-plus.N`（序号从 tag 名解析；无需出现在默认分支）；或 workflow_dispatch（可传 `plus_number` / `prerelease`）。
- 产物：Windows NSIS `*x64-setup.exe` + 便携 `*x64_portable.zip`（含 CLI sidecar）、macOS aarch64 DMG；自动创建**正式** Release（`prerelease` 输入可切回预发布）。
- 资源名统一 `0.3.3+N → 0.3.3-plus.N`（NSIS/DMG 文件名被 bundler 剥离构建元数据，重命名步骤补回）。
- 构建前 VERSION 改写为 `0.3.3+N`（sync-version 随之同步全配置）。
- **发版纪律**：⚠️ 未经用户明确要求**绝不自动发 release/打 tag**——完成工作的默认动作只到 commit + push；一个 commit 一个版本太多。

## 移植与优化方式（对照移植 soloMD 的经验）

- **移植是重写不是复制**：Vue → React、CodeMirror 单编辑器 → TipTap(IR)+CodeMirror(SV) 双模式。soloMD 的逻辑按 Tydora 的架构重放：位置/选区语义沿用 Tydora 自己的 find/replace 体系（IR=PM 位置、SV=源码偏移，同模式内自洽）。
- **上游已有等价实现时用上游**：外部修改重载（`reloadExternallyChangedBuffers`）上游 0.3.3 已实现，rebase 时用上游版本替掉本地等价逻辑，避免两套并存。
- **保留源项目的实战教训**：request_id 预铸造、keychain 异步化、空 bearer 不发送、系统打印替代位图导出——这些是 soloMD 踩坑后的修正，移植时必须带上。
- **历史整形**：squash 用树快照分组（`git checkout <sha> -- .` 按组边界取树），⚠️ 末组树必须用真正的最终 HEAD 快照（组边界顺序错会回退后续修复）；`git checkout <sha> -- .` 不处理文件删除，需核对。

## 已知问题与排查速查

| 症状 | 根因 | 处置 |
|---|---|---|
| Windows AI 报 `error sending request` | 系统代理劫持回环请求 | plus.7 起已修（no_proxy）；排查看红色胶囊错误链（`Connection refused (os error 11161)`=服务没起） |
| 标题切新文件、内容停留上一篇 | 同步 effect 的 isInternalRef 残留吞掉文件切换 | plus.8 起已修（fileChanged 无条件优先）；上游候选修复 |
| cargo 直连卡死 | crates.io 网络 | rsproxy 临时 CARGO_HOME |
| DMG 打包 AppleEvent 超时 | 无 GUI 会话 | 纯 hdiutil |
| AI 输出英文 | 提示词英文带偏 | plus.11 起已修（中文化 + 语言跟随规则） |

## 待办 / 候选

- 上游贡献候选：编辑器文件切换修复（`aae3160`，单一独立）——先开 issue 问维护者。
- workbuddy provider：待用户提供 API 形态后在 `providers.ts` 加条目即可。
- Anthropic 线格式：未移植（P0 三家用不到），加 provider 时需补 ~100 行 runner。
