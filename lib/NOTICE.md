# 第三方来源说明

本插件的协议层不是凭文档猜出来的，是把 [dsh-connect-doubao](https://www.npmjs.com/package/dsh-connect-doubao)（v0.8.3，MIT 许可）里已经跑通的豆包网页协议实现搬过来，再改造成「账号池 + 多账号 provider」。

## 搬运的文件

| 本仓库文件 | 来源 | 许可 | 改动 |
| --- | --- | --- | --- |
| `lib/doubao-core.js` | `dsh-connect-doubao@0.8.3` 的 `lib/doubao-quota-DLh2lZvL.js` | MIT | **内容逐字节相同**，只改了文件名。它本身不 import 任何宿主包，只依赖 `node:fs` / `node:os` / `node:path` / `node:crypto` / `node:child_process` / `node:net`。 |
| `lib/protocol/index.js` | 本仓库 | — | 把上面那份压缩代码里的短导出名（`$`、`Zt`、`G`…）映射成可读名字，重新导出。 |
| `lib/provider/adapter.js` | 本仓库 | — | 新写的 dsh-llm adapter。其中 `buildPrompt` 等价的 prompt 组装规则、`doubao-tool` 围栏约定，跟随 `dsh-connect-doubao@0.8.3` 的 `lib/doubao-status-DgvRlHxa.js` 里的实现（同一套约定，行为保持一致）。 |

## 我们改了哪些

- **凭据来源**：上游是「一个固定文件 + 单账号」，本插件改成「账号池：`~/.dsh/doubao-pool.json` + 每个账号一份 DPAPI 密封凭据」，读的时候现取当前号。
- **provider**：上游注册 `doubao`，本插件注册自己的 `doubao-pool`（显示「豆包工作（多账号）」），可以和豆包插件同时存在。
- **adapter**：上游用 `@earendil-works/pi-ai` + `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 起一个本地回环 HTTP 服务再转一手；本插件直接实现 `LlmAdapter` 契约（`stream()` 返回 `StreamChunk`），不 import 任何宿主包，因此不依赖宿主的模块解析。
- **失败换号**：上游没有；本插件在一次请求内按 401/402/403/408/429/5xx 换号重试一次。

## 许可证

上游 `dsh-connect-doubao` 使用 MIT 许可，允许使用、复制、修改、合并、发布、分发、再许可和销售，条件是保留版权声明与许可声明。原始版权归其作者所有。本项目在 MIT 之外没有附加限制。
