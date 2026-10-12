# Tydora 测试报告 — 2026-09-23

- **被测版本**：0.3.1（commit `67d2d35`）
- **测试环境**：Windows / Node 22.22.2 / Rust 1.97.1（cargo test 实际执行）
- **测试范围**：静态门禁 + 单元/集成测试 + CLI 实测复现 + 前端高风险模块代码审查
- **结论**：自动化门禁全绿，但**测试覆盖之外存在 3 个严重缺陷**（含 1 个破坏性数据风险、1 个数据损坏），建议发版前至少修掉 P0。

---

## 修复记录（2026-09-23 同日完成）

全部 14 条缺陷已修复并复验。改动均为外科式最小修改，未引入新依赖。

| 编号 | 状态 | 改动位置 |
|---|---|---|
| BUG-01 | ✅ 已修 | `tydora-core/src/note.rs` 新增 `is_safe_relative_id()`：显式拦盘符/UNC/根/`..` 组件 |
| BUG-02 | ✅ 已修 | `tydora-cli/src/store.rs` `list_notes` / `cmd_search` 改走 `note::resolve_notebook_dir` |
| BUG-03 | ✅ 已修 | `Editor/extensions/frontmatter.ts`、`Editor/frontmatter.ts` 正则末尾 `\n` → `(?:\n\|$)` |
| BUG-04 | ✅ 已修 | 27 处调用补 `sidebar.` 前缀；`dialog.confirm/cancel` 补进两份语言包 |
| BUG-05 | ✅ 已修 | `TipTapEditor.tsx` 句柄 `findMatches/selectMatch/selectAndScroll/replaceAt/highlightSearch/getValue` 增加 SV 分支转发给 CodeMirror；`CodeMirrorEditor.tsx` 新增用户态 `replaceRange` |
| BUG-06 | ✅ 已修 | `App.tsx` 新增 `guardSourceModeCommand`，5 个导出命令走同一闸门（复制 Markdown 改为可用） |
| BUG-07 | ✅ 已修 | `capabilities/default.json` 增加 `clipboard-manager:allow-write-image` |
| BUG-08 | ✅ 已修 | `commands/watcher_commands.rs` 重写为「目录 → (watcher, 引用计数)」map + `Drop` 显式停听；前端 `unwatch_vault` 带 `path` |
| BUG-09 | ✅ 已修 | `Settings.tsx` 通用设置改读-合并-写，并新增 storage 事件监听回填本地 state |
| BUG-10 | ✅ 已修 | `resolve_note_path` 仅在**已知 markdown 扩展名**时才跳过追加扩展 |
| BUG-11 | ✅ 已修 | `store.rs` 新增 `move_file()`：rename 失败回退复制+删除 |
| BUG-12 | ✅ 已修 | `export/xiaohongshu/save.ts`、`VaultManagerModal.tsx` ×2 改正斜杠拼接 |
| BUG-13 | ✅ 已修 | `utils/uiScale.ts` `lastAppliedScale` 移到 `await setZoom` 成功之后 |
| BUG-14 | ✅ 已修 | `errors.rs` 新增 `CliError::Parse`（前缀 `parse:`，退出码仍为 2） |
| BUG-15 | ✅ 已修 | 两份语言包各补 1 个 key |
| BUG-16 | ✅ 已修 | `BookmarksService`、`ImageManager`、`analytics.ts`、`Settings.tsx` 写入加 try/catch |
| BUG-17 | ✅ 已修 | `store.rs` 新增 `tmp_sibling()`：统一隐藏临时名 `.<文件名>.tmp` |

### 复验结果

| 验证项 | 结果 |
|---|---|
| `tsc --noEmit` | 通过，0 错误 |
| `vite build` | 通过（26.6s） |
| 前端单元测试（5 文件） | 94 条断言全过 |
| `cargo test -p tydora-core -p tydora-cli` | 全过（core 25 → **29**，新增 4 个回归测试） |
| `cargo check -p tydora-desktop` | 通过，0 警告 |
| i18n key 双向比对 | zh 1105 = en 1105，**双向零缺失**（此前各缺 1 + 27 处前缀错位） |
| CLI 穿越复验（5 条路径） | 全部 `Usage` / exit 2，vault 外文件完好 |
| CLI 含点文件名 | `show` / `edit` / `delete 2024.01.05` 全部可用（此前 not found） |
| CLI 4KB 边界中文笔记 | `list` / `search` 正常（此前整条命令 exit 2） |
| frontmatter 无尾换行往返 | 块类型 `horizontalRule+heading` → **`frontmatter`**，元数据原样保留 |
| 原子写临时文件残留 | 无 |

### 备注

- `tydora-cli` 有一条**既有**警告（`main.rs:47` Windows 控制台 UTF-8 的 `unsafe` 块，`-W unsafe-code` 触发），非本次引入，属有意为之。
- BUG-11 为代码审查确认 + 逻辑回退修复，未在跨卷机器上实测（本机 vault 与 `TYDORA_HOME` 同卷）。

---

## 一、基线：自动化检查结果（全部通过）

| 检查项 | 命令 | 结果 |
|---|---|---|
| TypeScript 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | 通过，0 错误 |
| 前端生产构建 | `vite build` | 通过（26.5s） |
| 前端单元测试（5 个文件） | `node --experimental-strip-types <file>` | 94 条断言全过 |
| Rust 测试（core + cli） | `cargo test -p tydora-core -p tydora-cli` | 84 个测试全过 |

> 说明：现有测试未覆盖下述任何缺陷，因此**门禁全绿不代表可发版**。

---

## 二、P0 — 严重（建议发版前必修）

### BUG-01 `delete`/`write`/`show` 可访问 vault 外任意文件（绝对路径穿越，破坏性）

| 字段 | 内容 |
|---|---|
| 模块 | CLI / MCP |
| 文件 | `app/tydora-core/src/note.rs:27-30`、`app/tydora-cli/src/store.rs`（show/edit/write/delete 调用点） |
| 前置条件 | 已知 vault 路径（`--vault`，或 MCP 客户端指定的工作目录） |
| 复现步骤 | 1. 在 vault 外建 `D:/tmp/outside.md`<br>2. 执行 `tydora --vault <vault> delete "D:/tmp/outside.md"` |
| 实际结果 | 输出 `Deleted (moved to trash): D:/tmp/...`，退出码 0；**vault 外文件被真实移入回收站** |
| 期望结果 | 拒绝并返回 Usage 错误（退出码 2），不得触碰 vault 之外 |
| 根因 | `resolve_note_path` 仅拦截 `..` / `/` / `\` 开头，**未拦截盘符绝对路径**（`C:/…`、`D:/…`）。`vault.join("D:/x.md")` 在 Windows 上直接替换 vault 前缀 |

**实测证据**：
```
$ tydora --vault D:/tmp-tydora-test/vault delete "D:/tmp-tydora-test/should-not-be-deletable.md"
Deleted (moved to trash): D:/tmp-tydora-test/should-not-be-deletable.md
Trash: D:/tmp-tydora-test/home\trash\vaults\af94d14a\should-not-be-deletable-1790129760.md
exit=0            # 删除后：该文件已不在原位置
```

**影响范围**：破坏性。MCP 白名单（`mcp.rs`）也不拦 `:`，AI 客户端可借此删除/覆盖 vault 外文件。

**修复建议**：在 `resolve_note_path` 增加绝对路径判定并拒绝（`Path::new(id).is_absolute()` + `Component::Prefix/RootDir`），并对最终路径做 `canonicalize()` 后校验仍在 vault 内。

---

### BUG-02 `list` / `search --notebook` 未做目录穿越校验（越权枚举 vault 外目录）

| 字段 | 内容 |
|---|---|
| 模块 | CLI / MCP |
| 文件 | `app/tydora-cli/src/store.rs:194`、`:710`（直接 `vault.join(notebook)`，未走 `resolve_notebook_dir`） |
| 复现步骤 | `tydora --vault <vault> list "../private"` |
| 实际结果 | 退出码 0，正常列出 vault 之外 `private/` 目录下的文件 id 与 **frontmatter 标题** |
| 期望结果 | 拒绝 `..`（`resolve_note_dir` 已有该校验，但 `list` 没调用） |

**实测证据**：
```
$ tydora --vault D:/tmp-tydora-test2/vault list "../private"
Notebook: ../private  (D:/tmp-tydora-test2/vault)
id                  title         size  mtime
../private/payslip  工资单 2026       84B  2026-09-23T02:20:49Z
  total: 1 note
exit=0
```
> 与 BUG-01 互补：`show` 拦住了 `..` 但放过绝对路径；`list` 两者都放过。

---

### BUG-03 frontmatter 无尾换行时被解析成水平线 + 标题，保存后元数据损坏

| 字段 | 内容 |
|---|---|
| 模块 | 编辑器（IR 模式） |
| 文件 | `app/tydora-web/src/Editor/extensions/frontmatter.ts:230`（解析正则）、`:212-219`（序列化） |
| 前置条件 | 笔记以 `---` 结尾且**末尾无换行符**（很多工具/脚本写出的文件如此） |
| 复现步骤 | 打开一篇内容为 `---\ntitle: x\ntags: [a, b]\n---`（EOF 无换行）的笔记，然后 Ctrl+S |
| 实际结果 | 元数据块被显示为「分割线 + 二级标题」；**保存后文件变成 `---\n\n## title: x tags: \[a, b\]`**，YAML 结构丢失 |
| 期望结果 | frontmatter 正常识别为元数据块并原样保存 |
| 根因 | 正则 `/^---\s*\n([\s\S]*?)\n---\s*\n/` 末尾**强制要求换行**；无尾换行时不匹配 → `---` 落入 markdown-it 默认规则（首行 `---` → `<hr>`，其后 `---` → setext H2 下划线） |

**实测证据**（jsdom + 真实 TipTap Editor 往返）：
```
### 带尾换行（正常）
输入:   "---\ntitle: x\ntags: [a, b]\n---\n\n# 标题\n"
块类型: ["frontmatter","heading"]          序列化: "---\ntitle: x\ntags: [a, b]\n---\n\n# 标题"   ✓

### 不带尾换行（EOF 结束）
输入:   "---\ntitle: x\ntags: [a, b]\n---"
块类型: ["horizontalRule","heading"]       ← 未识别为 frontmatter
序列化: "---\n\n## title: x tags: \\[a, b\\]"   ← 元数据损坏
```

**修复建议**：正则末尾改为 `(?:---\s*(?:\n|$))` 形式（`\n` 改为 `\n|\z`），序列化侧不受影响。

---

## 三、P1 — 高

### BUG-04 i18n key 命名空间错位：书签功能整片显示原始 key

| 字段 | 内容 |
|---|---|
| 文件 | `Bookmarks/BookmarkDialog.tsx`、`Bookmarks/BookmarksPanel.tsx`、`Bookmarks/BookmarksService.ts:62,122`、`components/ConfirmDialog.tsx:39-40` |
| 根因 | 语言包实际 key 在 `sidebar.bookmarks.*` / `sidebar.toast.*` / `sidebar.dialog.*` 下，代码却调用 `bookmarks.*` / `toast.*` / `dialog.*`，两边无交集；i18next 无 `saveMissing`，直接回显 key 字符串 |
| 复现步骤 | 打开书签面板 / 右键「添加书签」/ 在侧栏删除文件 |
| 实际结果 | 界面显示 `bookmarks.dialog.addTitle`、`bookmarks.panel.empty`、`dialog.confirm` 等原始 key（中英文均如此） |
| 影响 | 书签功能 UI 基本不可读；`BookmarksService.ts:62` 还会把原始 key 字符串**持久化进 localStorage 当作分组名** |

**实测证据**（全量扫描 969 个静态 key 交叉比对语言包）：确证错位 key 共 **27 个**，例如
`bookmarks.dialog.{addTitle,editTitle,path,title,emptyTitleHint,group,selectGroup,noGroups,newGroupPlaceholder,newGroup,cancel,save}`、`bookmarks.panel.{noVault,empty,emptyHint,dropHere}`、`bookmarks.contextMenu.{openInNewWindow,editTitle,unfavorite,copyPath,rename,deleteGroup}`、`bookmarks.{defaultGroup,ungrouped,editTitlePrompt}`、`toast.pathCopied`、`dialog.{confirm,cancel}`。

**修复建议**：统一给这些调用加 `sidebar.` 前缀（或反之调整语言包，二者选一并加一条 i18n key 存在性单测防回归）。

---

### BUG-05 源码模式（SV）下查找替换失效，且匹配计数来自过期文档

| 字段 | 内容 |
|---|---|
| 文件 | `App.tsx:4242`（渲染门控）、`App.tsx:2796-2803`（Ctrl+F 快捷键）、`Editor/TipTapEditor.tsx:2418-2440`、`:2496-2499`、`:2718` |
| 根因 | ① 门控只有 `findReplaceDialogMode && isCurrentFileMarkdown`，**未判断当前是否 SV**（而导出按钮有 `effectiveMode === "sv"` 守卫，说明 SV 限制是已知设计）；② SV 时 `EditorContent` 被卸载 → `editor.view = null`（TipTap `unmount()` 会 `editorView.destroy()`）；③ SV 期间外部 value 同步 effect 直接 `return`，TipTap 文档不更新 |
| 复现步骤 | 切到源码模式 → Ctrl+F → 输入关键词 → 点「下一个」/「替换」 |
| 实际结果 | ① 计数与源码内容不符（读的是进入 SV 前的 IR 文档）；② 跳转/替换静默无反应（`editor.chain()` 因 view 为 null 抛错，被 try/catch 吞掉） |
| 期望结果 | 要么禁用该入口（与导出按钮一致），要么让查找替换作用于源码文本 |

> 注：`getValue()` 同样读 TipTap storage，在 SV 期间返回过期 markdown（见 BUG-06）。

---

### BUG-06 命令面板绕过「源码模式」守卫，复制/导出拿到过期内容

| 字段 | 内容 |
|---|---|
| 文件 | `App.tsx:3599-3604`（命令面板 6 个入口）、`App.tsx:3839-3842` / `4162-4164`（导出按钮守卫，对照） |
| 根因 | 导出按钮已用 `if (effectiveMode === "sv" \|\| exporting) return;` 拦截，但命令面板的 `copy-markdown` / `copy-wechat` / `export-pdf` / `export-html` / `export-docx` / `export-png` 直接调用同一批 handler，**没有该守卫** |
| 复现步骤 | 切到源码模式 → 编辑内容 → 打开命令面板 → 执行「复制为 Markdown」或任一导出 |
| 实际结果 | `handleCopyAsMarkdown` → `getValue()` 返回**进入 SV 之前**的内容，本次编辑丢失 |
| 期望结果 | 与按钮行为一致：SV 下拦截或提示 |

---

### BUG-07 剪贴板权限缺失：脑图「复制图片」必然失败

| 字段 | 内容 |
|---|---|
| 文件 | `app/tydora-desktop/capabilities/default.json:72`、`mindmap/MindmapView.tsx:6,701` |
| 根因 | 只声明了 `clipboard-manager:default`，而该插件 `default_permission.permissions = []`（官方注释：「No features are enabled by default」）。`write_image` 属于 `clipboard-manager:allow-write-image`，未声明 → 被 ACL 拒绝 |
| 复现步骤 | 打开思维导图 → 复制为图片 |
| 实际结果 | `writeImage` 抛 ACL 拒绝错误，被 catch 后仅打 console，界面无任何反馈 |
| 期望结果 | 正常写入剪贴板，或明确提示失败原因 |
| 修复建议 | `capabilities/default.json` 增加 `"clipboard-manager:allow-write-image"`（若还需读剪贴板一并加 `allow-read-image`） |

---

### BUG-08 watcher 全局单例：关闭任一窗口后所有窗口丢失文件变更监听

| 字段 | 内容 |
|---|---|
| 文件 | `app/tydora-desktop/src/commands/watcher_commands.rs:5,42-52`；前端 `services/useVaultWatcher.ts:58,114`；调用方 `App.tsx:1226`、`graph/GraphWindow.tsx:68` |
| 根因 | `WatcherState(Mutex<Option<RecommendedWatcher>>)` 是**单槽位、无引用计数**；`unwatch_vault` 无条件 `*guard = None` |
| 复现步骤 | 同时打开主窗口与图谱窗口（都会 `watch_vault`）→ 关闭图谱窗口 |
| 实际结果 | `unwatch_vault` 清空全局 watcher，**主窗口此后收不到 `vault://changed`**，外部修改不再自动刷新；无重试机制 |
| 期望结果 | 按窗口引用计数，仅当最后一个使用者退出时才停止监听 |

---

### BUG-09 跨窗口设置覆盖写：拖拽侧栏 Tab 的布局会被设置窗口回滚

| 字段 | 内容 |
|---|---|
| 文件 | `App.tsx:827-837`（读-合并-写）、`App.tsx:578-580`（storage 监听）、`Settings.tsx:255, 3121-3126`（整体覆盖写） |
| 根因 | 两处写同一个 key `zmd-general-settings`，但策略不同：App 用「读现有一合并 sidebarTabPlacement一写回」，Settings 的 `useEffect([generalSettings])` 把**挂载时载入的整个陈旧对象**整体覆盖写回 |
| 复现步骤 | 打开设置窗口 → 回主窗口拖拽侧栏 Tab 换边 → 再在设置窗口改任意一项设置 |
| 实际结果 | Settings 的陈旧 state 覆盖写入 → App 的 storage 监听把 `sidebarTabPlacement` 回滚到旧值 → 拖拽被撤销 |
| 期望结果 | 两处都做读-合并-写，或 Settings 也监听 storage 事件 |

---

## 四、P2 — 中

### BUG-10 含点（`.`）的笔记无法访问：`list` 输出的 id 喂不回 `show`

- 文件：`app/tydora-core/src/note.rs:33`（`raw_pb.extension().is_some()` 即视为已带扩展名，只试字面路径）；`store.rs` id 反解处
- 复现：`list` 显示 id `2024.01.05` → `tydora show "2024.01.05"` → `not found: note '2024.01.05' not found (tried: ...\2024.01.05)`，退出码 3
- 原因：`PathBuf::extension()` 对 `2024.01.05` 返回 `Some("05")`，于是不再尝试追加 `.md`
- 影响：日期/版本号命名的笔记全部无法 show/edit/delete；`a.md.md` 同理。**id 往返一致性破坏**

### BUG-11 跨卷删除失败（`fs::rename` 无回退）

- 文件：`app/tydora-cli/src/store.rs:517`
- 场景：vault 在 D: 盘，`TYDORA_HOME` 默认在 C:（trash 目录所在）→ Windows `fs::rename` 跨卷报 `ERROR_NOT_SAME_DEVICE`，删除直接失败
- 修复建议：跨卷时回退为「复制 + 删除源文件」

### BUG-12 硬编码 Windows 反斜杠拼接路径（macOS/Linux 不可用）

- 文件：`export/xiaohongshu/save.ts:34`（`` `${dir}\${name}` ``）、`VaultManager/VaultManagerModal.tsx:137`、`:227`（`... + "\\" + ...`）
- 影响：非 Windows 平台会生成含字面反斜杠的错误文件名，导出小红书卡片 / 新建或移动仓库失败（项目含 `packaging/aur/`，Linux 为目标平台之一）

### BUG-13 `applyUiScale` 一旦失败即永久不生效

- 文件：`utils/uiScale.ts:59-60`
- 原因：`lastAppliedScale = target` 写在 `await getCurrentWebview().setZoom(target)` **之前**；若 `setZoom` 抛错（webview 未就绪等），catch 只打日志，但差值判据 `< 0.005` 会让后续所有同值调用提前 return
- 修复建议：把赋值移到 await 成功之后，或在 catch 中回滚 `lastAppliedScale`

---

## 五、P3 — 低

| 编号 | 问题 | 位置 |
|---|---|---|
| BUG-14 | 内容解析失败被归类为「用法错误」，报错前缀误导：实测 `tydora: usage: note head is not UTF-8: ...`，用户会以为是参数写错 | `errors.rs:75`（`CoreError::Parse → CliError::Usage`）；`note.rs:129` |
| BUG-15 | 语言包各缺 1 个 key：`sidebar.toast.duplicatedAndCopied` 仅 zh-CN 有（en-US 缺失，英文界面「复制副本」toast 回显 key）；`app.error.openTerminalFailed` 仅 en-US 有 | `i18n/locales/{zh-CN,en-US}.json` |
| BUG-16 | 多处 `localStorage.setItem` 无 try/catch（配额溢出 / 隐私模式抛错）；位于 `useEffect` 中的写入会冒泡到 React 提交阶段 | `Bookmarks/BookmarksService.ts:36`、`services/ImageManager.ts:148`、`Settings.tsx:3122/3140/3155`、`analytics.ts:71/77/82` |
| BUG-17 | 原子写临时文件名不一致：一处用隐藏名 `.{id}.md.tmp`，另两处用非隐藏 `note.md.tmp` → 会出现在文件树并触发 watcher 结构刷新；并发同写存在竞争 | `store.rs:468` vs `:588` / `:626` |

---

## 六、待补充验证 / 提请注意

- **BUG-11** 为代码审查确认（未实测跨卷场景，需在 vault 与 TYDORA_HOME 分属不同卷的机器上复现）。
- ~~**frontmatter 无尾换行**（BUG-03）建议同时检查 CLI 侧正则~~ → **已在第二轮一并处理**：实际存在 **三份**独立副本（外加 `tags/TagIndexService.ts`），现已收口为 `FRONTMATTER_RE` 唯一副本；Rust 侧 `frontmatter::split` 是逐行扫描，本来就正确，无需改动。
- 现有前端测试均以 `node --experimental-strip-types <file>` 手动运行、无统一 runner，新增回归测试时需沿用该约定。**已解除的约束**：早期 `Editor/extensions/frontmatter.ts` 使用无扩展名相对导入、无法被 Node ESM 直接 import，导致解析逻辑测不到（BUG-18 正是这么漏掉的）；现已把纯逻辑提到无依赖的 `Editor/frontmatter.ts`，`frontmatter.test.ts` 可直接运行，不再需要临时补 `.ts` 扩展名的 hack。

## 七、建议的修复优先级

1. **BUG-01 / BUG-02**（越权 + 破坏性）— 安全边界，务必发版前修
2. **BUG-03**（数据损坏）— 影响用户既有笔记
3. **BUG-04 ~ BUG-09** — 功能可用性
4. **BUG-10 ~ BUG-13** — 具体场景失效
5. **BUG-14 ~ BUG-17** — 体验与健壮性

---

## 八、第二轮：用户反馈缺陷（2026-09-23）

- **来源**：用户反馈 —— 「输入元数据后，在源码模式下在元数据中输入一个空行，然后切换到 IR 模式下有异常」
- **排查方式**：jsdom + 真实 TipTap Editor（StarterKit + tiptap-markdown + Frontmatter）跑 SV→IR→SV 往返，10 组围栏边界用例；再用 markdown-it 做 token 级断言定位根因
- **结论**：反馈属实且可 100% 复现。另外在同一次排查中连带发现 2 条同族缺陷（共 3 条）

### BUG-18 · P0 · 元数据内含空行 → 元数据泄漏成正文，保存即损坏

| 字段 | 内容 |
|---|---|
| 复现环境 | 0.3.1 / Windows / IR ↔ SV 双模式编辑器（元数据块默认启用） |
| 前置条件 | 笔记已有 frontmatter；`editorSettings.frontmatter !== false` |
| 复现步骤 | ① IR 模式在元数据块写入 `title: hello` 与 `tags: a, b` 两行 → ② 切到源码模式（SV）→ ③ 在两行之间插入一个空行 → ④ 切回 IR 模式 → ⑤ 再切回 SV 或直接保存 |
| 实际结果 | IR 模式下元数据框只剩 `title: hello`，`tags: a, b` **变成普通段落**，正文前多出一个空段落；源码变为 `---\ntitle: hello\n---\n\ntags: a, b\n\n正文`（闭围栏上移，后半截元数据流入正文） |
| 期望结果 | 元数据块完整保留空行，`tags: a, b` 仍属于元数据 |
| 影响范围 | 所有含 frontmatter 的笔记；元数据里敲过一个空行即必然触发，**保存后不可逆** |
| 是否阻断 | 是（数据损坏） |

**根因（token 级实证）**：解析规则把 YAML 原样注入 `<div data-type="frontmatter">…</div>` 后交给 markdown-it 解析。markdown-it 的 `html_block` 规则（CommonMark type 6，`<div` 属于块级标签）**遇到空行即结束该块**：

```
注入 <div …>a\n\nb</div>\n\n正文  →
  html_block   "<div data-type=\"frontmatter\">a\n"
  paragraph    "b</div>"          ← 元数据泄漏成正文
  paragraph    "正文"
```

**修复**：`Editor/frontmatter.ts` 新增 `rewriteFrontmatterAsHtml()`：YAML 的换行编码为字符实体 `&#10;`，使占位块保持**单行**；TipTap 的 DOMParser 解析 HTML 时把实体还原成真实换行，文本内容一字不差（`escapeHtml` 先做、`&#10;` 后加，顺序不可反）。

### BUG-19 · P1 · 空元数据 `---\n---` 被解析成两条水平线

| 字段 | 内容 |
|---|---|
| 复现步骤 | 源码模式下写入只有开闭围栏、无内容的元数据（`---\n---`，闭围栏前没有空行） |
| 实际结果 | IR 模式出现**两条水平线**，METADATA 卡片消失；源码被改写成 `---\n\n---` |
| 期望结果 | 识别为空元数据块 |
| 附带问题 | 与 `---\n\n---`（闭围栏前有空行）之间**来回漂移**：`---\n---` → `---\n\n---` → 稳定，但重新打开又回到两条线 |
| 影响范围 | 空元数据笔记；以及与 CLI 的判定分裂 —— Rust 侧 `frontmatter::split` 逐行扫描、**本来就认**这种形态（已有测试 `extract_title_falls_back_to_h1`），于是出现「GUI 显示两条水平线、CLI 认为有 frontmatter」 |
| 根因 | 原正则 `^---\s*\n([\s\S]*?)\n---\s*(?:\n\|$)` 要求闭围栏**前必须有换行**，`---\n---` 匹配不上 |
| 修复 | 闭围栏前的换行改为可选：`(?:\r?\n)?---` |

### BUG-20 · P1 · 围栏正则存在三份独立副本

| 字段 | 内容 |
|---|---|
| 实际问题 | `Editor/extensions/frontmatter.ts`、`Editor/frontmatter.ts`、`tags/TagIndexService.ts` 各存一份语义相近但不一致的正则（第三份连末尾 `(?:\n\|$)` 都没有） |
| 影响范围 | 只改一处就会出现「编辑器识别出的元数据块」与「标签索引 / 本地图谱提取到的元数据」不一致；BUG-03 修复时只改了两处，第三处即被遗漏 |
| 修复 | 收口为 `Editor/frontmatter.ts` 导出的 `FRONTMATTER_RE` 唯一副本，三处共用（非 global 正则，无 `lastIndex` 状态，可安全共享同一实例） |

### 修复改动

| 文件 | 改动 |
|---|---|
| `app/tydora-web/src/Editor/frontmatter.ts` | 新增导出 `FRONTMATTER_RE`（唯一副本，含边界说明）；新增 `rewriteFrontmatterAsHtml()` 与私有 `escapeHtml()` |
| `app/tydora-web/src/Editor/extensions/frontmatter.ts` | 解析规则改为调用 `rewriteFrontmatterAsHtml()`（变薄包装，删除本地 `escapeHtml` 与正则） |
| `app/tydora-web/src/tags/TagIndexService.ts` | 改用 `FRONTMATTER_RE` |
| `app/tydora-web/src/Editor/frontmatter.test.ts` | **新增**永久回归测试，55 条断言（见下） |
| `app/tydora-core/src/frontmatter.rs` | 新增 2 个测试锁定「空行不截断围栏」「空元数据可识别」的前后端一致契约 |

### 复验结果（修复后）

| 验证项 | 修复前 | 修复后 |
|---|---|---|
| 元数据含 1 个空行 | IR 只剩半截 + 正文多出段落；源码泄漏 | `frontmatter("title: hello\n\ntags: a, b")`，**字节级原样往返** |
| 元数据含 2 个空行 | 同上 | 字节级原样往返 |
| CRLF + 元数据空行 | 泄漏 | 字节级原样往返（原样保留 LF 归一化后的结构） |
| 空元数据 `---\n---` | 两条水平线，卡片消失 | `frontmatter("")`，稳定往返 |
| 空元数据 `---\n\n---` | 与上者来回漂移 | `frontmatter("")`，稳定 |
| 开围栏后空行 | 空行被静默吞掉 | 空行保留（`frontmatter("\ntitle: hello")`） |
| 无尾换行（EOF 闭围栏） | 已修（第一轮 BUG-03） | 保持通过 |
| 未闭合围栏 / 四个短横 / 无围栏 | 不识别 | 不识别（未误判） |
| markdown-it 占位块 | 空行时闭标签被挤出首块 | 始终单个 `html_block`，无元数据泄漏 |

**已知的可接受归一化（非缺陷，稳定不漂移）**：闭围栏**紧邻的前一个空行**会被规范掉（`---\ntitle: x\n\n---` → `---\ntitle: x\n---`）。YAML 语义上空行无意义，内容本身不丢失，且往返稳定。

### 新增回归测试

`app/tydora-web/src/Editor/frontmatter.test.ts`（55 条断言，纯依赖、无需 jsdom）分三组：

1. `extractFrontmatter` / `FRONTMATTER_RE` 围栏边界：空行、空元数据、无尾换行、CRLF、未闭合、四短横、多闭围栏、共享正则无状态
2. `rewriteFrontmatterAsHtml`：**占位块内容不含裸换行** + 实体解码后与原始 YAML 完全一致 + HTML 特殊字符被转义
3. markdown-it token 级：占位块始终是**单个** `html_block`、闭标签在块内、无元数据泄漏成正文行 —— 并附**反证**用例（不编码换行时必然失败），确保该断言真的能拦住 BUG-18

> 该测试能直接运行是本次结构性改进的结果：解析逻辑此前埋在扩展文件里，而扩展文件使用无扩展名相对导入，Node ESM 无法加载 → 回归测试写不出来，缺陷因此长期漏检。

