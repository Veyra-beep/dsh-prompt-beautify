# dsh-prompt-beautify

DeepSeek Harness 提示词美化插件：输入框旁一键把草稿改写成更清晰、更完整的提示词；宿主同时提供 `/polish` 斜杠命令。

[English](./README.en.md)

- **不发送、不计入对话**：命令与按钮都不产生 model message，美化的输入和结果都不进会话历史，也不占主对话 token。
- **继承当前模型**：辅助请求优先用本会话最近一次请求的 provider/model，其次是 profile 里 `agent-default-model` 的当前选择。
- **零第三方依赖**：宿主只用 `commands` 与 `llm` 两个服务；客户端是手写懒加载 CJS bundle，不 import 任何 `@deepseek-ai/dsh-client-*`。

## 用法

在输入框写入草稿后：

- 点输入框左下工具条里的 **✨ 美化**：原地改写草稿，不发送；改写后出现 **撤销** 可恢复原稿；也可用编辑器自带的 Ctrl/Cmd-Z。
- 或直接敲命令：

  ```
  /polish 帮我看下这段代码有什么问题
  ```

  命令结果不会进入对话历史。

客户端按钮通过 `--b64 <base64>` 把草稿原样交给命令，因此换行、缩进、Markdown 都保持原样；手工输入时命令后直接跟文本即可。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（升级不丢）：

```yaml
- id: prompt-beautify
  config:
    # 固定路由（省略则继承当前会话模型）
    # provider: ds
    # model: deepseek-v4.1-flash-1017
    maxInputChars: 8000   # 草稿字符上限，超过直接报错不请求
    maxTokens: 2048       # 改写结果 token 上限
    timeoutMs: 45000      # 单次改写超时
    # traceFile: C:\path\to\polish.log   # 排障开关：每次 apply 追加一行，确认插件被装载
```

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主：注册 `/polish`，解析路由，调用 `ctx.llm.stream` 流式收集结果 |
| `lib/client.js` | 客户端：`conversation.input.left` 槽位里的按钮，读草稿 / 回填 / 撤销 |
| `cordis.patch.yml` | 往 profile 组合里插一行 `prompt-beautify` |
| `test/host.test.mjs` | 宿主命令的 node:test 用例（10 个，不需要真实模型） |
| `test/client.smoke.mjs` | 客户端 bundle 的离线 smoke 测试（需要 react@18） |

依赖的两个宿主服务：`commands`（斜杠命令表）与 `llm`（provider-neutral 补全服务），二者都在 DSH 默认 composition 里。

## 安装

```powershell
dsh plugin --profile <profile> add <本目录绝对路径>
```

安装会把本包加进 profile 的 `dsh.profile.bundles`，并让包自带的 `cordis.patch.yml` 插入 `prompt-beautify` 行。

若本包已发布到 npm，也可以直接按包名安装：

```powershell
dsh plugin --profile <profile> add dsh-prompt-beautify
```

## 兼容性

在 DSH `0.2.0-rc.2` + Web 客户端上实测可用；`package.json` 的 `dsh.compatibility` 声明了同样的下限与已验证版本。插件不 import 任何 Harness 核心包，只通过 cordis 服务（`commands`、`llm`、`slots`、`remote.commands`）交互，因此对版本漂移不敏感。

## 重载语义（实测）

- 改 **profile 的 `cordis.patch.yml`**（含本插件的 config）→ HMR 立刻重组，无需重启。
- 改 **本包 `lib/index.js` / `lib/client.js`** → 不会热重载：宿主模块不会重新 import，客户端 bundle 也不会重新构建。要让新代码生效：重启 DeepSeek Harness（宿主）+ 刷新 Web 页面（客户端）。
- 纯注释改动不触发重组。

## 测试

```powershell
node --test test/              # 宿主命令逻辑，10 个用例，不需要真实模型
node test/client.smoke.mjs     # 客户端 bundle：假 slots/remote + react-dom/server 渲染
```

`client.smoke.mjs` 需要本包旁边能解析到 `react@18` / `react-dom@18`；装不到时脚本打印 `SKIP` 并以 0 退出。它校验的是：模块 id 与 `inject` 列表、`slots.inject` 的 owner key 必须是槽名、注册参数、`remote.commands.execute` 接线、缺 props 时降级为不渲染并只告警一次、以及空草稿/非 plain 阶段禁用按钮。

## 许可证

MIT，见 [LICENSE](./LICENSE)。