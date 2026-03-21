---
name: gemini-skill
description: 通过 Gemini 官网（gemini.google.com）执行生图操作。用户提到"生图/画图/绘图/nano banana/nanobanana/生成图片"等关键词时触发。所有浏览器操作已封装为 MCP 工具，AI 无需手动操控浏览器，但必要时可以通过gemini_browser_info获取浏览器连接信息，方便AI自行连接调试。
---

# Gemini Skill

## 触发关键词

- **生图任务**：`生图`、`画`、`绘图`、`海报`、`nano banana`、`nanobanana`、`image generation`、`生成图片`
- 若请求含糊，先确认用户是否需要生图

## 使用方式

本 Skill 通过 MCP Server 暴露工具，AI 直接调用即可，**不需要手动操作浏览器**。

浏览器启动、会话管理、图片提取、文件保存等流程已全部封装在工具内部。Daemon 未运行时会自动后台拉起，无需手动启动。

### ⚠️ 强制规则

> **AI 必须始终通过 MCP 工具完成所有操作。**
>
> 禁止绕过 MCP 自行编写临时脚本（如 `node -e "..."` 或创建 `.js` 临时文件）来
> `import` / `require` 本项目导出的函数（如 `createGeminiSession`、`createOps` 等）。
>
> 如果 MCP 工具确实无法满足当前需求，AI **必须先向用户说明原因并获得明确同意**，
> 才能编写临时脚本调用底层 API。未经用户同意，一律禁止。

### 可用工具

**核心生图（封装完整流程）：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_generate_image` | 完整生图流程：新建会话→发prompt→等待→提取图片→保存本地 | `prompt`，`newSession`（默认false），`referenceImages`（参考图路径数组，默认空） |

**会话管理：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_new_chat` | 新建一个空白对话 | 无 |
| `gemini_temp_chat` | 进入临时对话模式（不保留历史记录） | 无 |

**模型切换：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_switch_model` | 切换 Gemini 模型 | `model`（`pro` / `quick` / `think`） |

**文本对话：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_send_message` | 发送文本消息并等待回答完成 | `message`，`timeout`（默认120000ms） |

**图片操作：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_upload_images` | 上传图片到输入框（仅上传不发送，可配合 send_message） | `images`（路径数组） |
| `gemini_get_images` | 获取会话中所有已加载图片的元信息 | 无 |
| `gemini_extract_image` | 提取指定图片的 base64 并保存到本地 | `imageUrl`（从 get_images 获取） |

**诊断 & 恢复：**

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `gemini_probe` | 探测页面各元素状态（输入框、按钮、模型等） | 无 |
| `gemini_reload_page` | 刷新页面（卡住或异常时使用） | `timeout`（默认30000ms） |
| `gemini_browser_info` | 获取浏览器连接信息（CDP 端口、wsEndpoint 等） | 无 |

### 典型用法

**快速生图（一步到位）：**
1. 调用 `gemini_generate_image`，传入 prompt → 返回本地图片路径

**灵活组合（细粒度控制）：**
1. `gemini_new_chat` — 新建会话
2. `gemini_switch_model` → `pro` — 切换到高质量模型
3. `gemini_upload_images` — 上传参考图
4. `gemini_send_message` — 发送描述词
5. `gemini_get_images` → `gemini_extract_image` — 获取并保存图片

**排障：**
1. `gemini_probe` — 看看页面元素有没有就位
2. `gemini_reload_page` — 页面卡了就刷新
3. `gemini_browser_info` — 获取 CDP 信息自行连接调试

## MCP 客户端配置

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node",
      "args": ["<项目绝对路径>/src/mcp-server.js"]
    }
  }
}
```

也可通过 `npm run mcp` 手动启动。

## 失败处理

工具内部已包含重试逻辑。若仍然失败，返回值的 `isError: true` 和错误信息会告知原因：

- **生成超时** — 建议用户简化描述词后重试
- **Daemon 未启动** — 工具会自动拉起，若仍失败可手动 `npm run daemon`
- **页面异常** — 可调用 `gemini_browser_info` 查看浏览器状态排查

## 参考

- 详细执行与回退：`references/gemini-flow.md`
- 关键词与路由：`references/intent-routing.md`
