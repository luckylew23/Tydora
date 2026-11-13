# AI 助手无法连接本机 API — 排查记录（plus.7 修复）

> 2026-11-12 · Windows。症状：设置「OpenAI 兼容」provider，Base URL 指向本机 API
> （`127.0.0.1:PORT`，后确认 `localhost` 同样失败），「获取模型列表 / 保存并验证」报
> `error sending request for url ...`。同一台机器上浏览器访问该地址正常，soloMD 也正常。

## 症状与对照证据（诊断的起点）

| 现象 | 推论 |
|---|---|
| Tydora 报 `error sending request` | 这是**传输层失败**——连 HTTP 状态码都没到，不是服务器返回错误，是请求根本没送达 |
| 浏览器访问同一地址可以 | 服务在跑、端口在监听、OS 网络正常 → 服务端与网络无辜 |
| soloMD（同机）可以 | 差异不在运行环境，在 **HTTP 客户端库的行为** |

三条合起来：问题锁定在 Tydora 自己的 HTTP 客户端（reqwest）的某种行为差异上。

## 诊断链

1. `error sending request for url` = reqwest 传输层错误 → 请求没发出去，或被发去了错误的地方。
2. 浏览器 / soloMD 都能连 → 排除服务端与网络，只剩客户端差异。
3. 对比依赖版本：Tydora 的 reqwest 为 0.12.28，soloMD 锁的是不读系统代理的旧版。
4. 关键版本行为差异：**reqwest 0.12.5+ 默认读取系统代理**（Windows 上即注册表 WinINET 代理设置）。
5. 用户开着 Clash 类工具的系统代理 → Tydora 对 `127.0.0.1:PORT` 的请求被塞进代理端口 →
   代理不接受回环目标的转发 → 传输失败。

浏览器为什么没事：浏览器对 localhost 自带直连豁免（不走系统代理），所以「浏览器能访问」
这个证据恰恰掩盖了代理层的异常——它验证的是服务在跑，而不是代理路径通畅。

## 根因

reqwest 0.12.5+ 默认读取系统代理（库升级静默改变了网络行为）+ 用户系统代理开启 →
**回环地址（127.0.0.1 / localhost / ::1）的请求被代理端口劫持**。

## 修复（随 plus.7 发布，现并入 feat(ai) 提交）

全部在 `app/tydora-desktop/src/commands/ai_commands.rs`：

- `is_loopback_base(base)` —— 解析 base URL 的 host；`localhost` / `::1` / 回环 IP → true。
- `http_client_for(base)` —— 回环目标 → `Client::builder().no_proxy()`（绕过一切代理直连）；
  远程目标 → 常规客户端（继续遵守系统代理）。
- 应用到**全部网络路径**：`ai_verify_key` / `ai_list_models` / `run_openai` / `run_ollama`
  （流式改写同样受益）——漏一条就还有一条路径被劫持。
- 顺带 `error_chain()`：错误显示时展开完整 `source()` 链（动机见教训 2）。

## 设计要点：为什么是「按目标禁代理」而不是全局禁

- 全局禁代理会伤害远程 provider 用户——DeepSeek 等在墙内恰恰**需要**走系统代理。
- 正确规则按目标二分：**回环 = 永不代理（本机 API 永远直连）；远程 = 尊重系统代理**。
- 因此修复放在「按目标构建 client」的函数里，而不是任何全局开关/配置。

## 经验教训

1. **「别人能连、我不能」→ 先查客户端库的版本行为差异**，不要先怀疑服务器/网络。
   reqwest 0.12.5+ 的系统代理默认值就是典型：依赖升级悄悄改了网络行为，表象却是
   「我的应用坏了」。
2. **reqwest 顶层错误 Display 会吞真实原因**：只显示 `error sending request for url`，
   Connection refused / 代理拒绝 / 超时全部埋在 `source()` 链上——错误上报必须展开整条链
   （本仓库 `error_chain()` 已做，这也是这次能快速定位的间接助力）。
3. **localhost 永不走代理**是本机 API 客户端的硬规则；浏览器就是这么干的。
4. 用户报告「localhost 也不行」时别怀疑方向错了——同一根因覆盖整个回环族，
   修复必须同时覆盖 `127.0.0.1` / `localhost` / `::1`，缺一个就还有一片用户连不上。
5. **复测前先确认用户跑的版本**：当时用户测的是 plus.6（无修复），修复在 plus.7——
   对着旧版本复测会把排查方向带偏。

## 复发时的速查（看设置页红色胶囊的完整错误链）

| 错误链关键字 | 含义 | 处置 |
|---|---|---|
| `Connection refused (os error 11161)` | 目标端口无人监听 | 起服务 / 核对端口 |
| 出现 proxy 或连接代理端口字样 | 请求仍走了代理 | 理论上 plus.7 后不应出现；出现说明该路径没走 `http_client_for`，是回归 |
| timeout / 连接超时 | 防火墙拦截或服务 hang | 查防火墙与本机服务状态 |
