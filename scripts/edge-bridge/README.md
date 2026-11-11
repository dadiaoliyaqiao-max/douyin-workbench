# DSH Edge Bridge（独立 Edge 桥）

给本工作区的会话 1/2 提供 **Edge** 浏览器只读控制；与 Chrome 版
（`docs/浏览器桥接.md` 记录的 127.0.0.1:8787 那套）**并行独立**，
两个浏览器各用一条 relay，互不抢命令。

```text
Edge 扩展 "DSH Edge Bridge"（本目录 extension/，unpacked，chrome.debugger/CDP）
   └─ 长轮询 GET http://127.0.0.1:8788/poll
本目录 relay.mjs（node 运行，仅绑定 127.0.0.1:8788）
   └─ POST /rpc ←── client.py
```

## 启动（推荐：独立 Edge 配置，免手动装扩展）

1. 启动 relay（保持窗口开着；也可以让 DSH 后台任务常驻）：
   双击 `scripts\edge-bridge\start-relay.cmd`；
   或在终端执行：
   ```powershell
   node "{{INSTALL_DIR}}\scripts\edge-bridge\relay.mjs"
   ```
2. 双击 `scripts\edge-bridge\start-edge.cmd` 启动 Edge。
   它使用独立配置目录 `%LOCALAPPDATA%\DSH-Edge-Bridge\profile`，
   并通过 `--load-extension` 自动加载本目录的扩展，不碰你日常的 Edge 配置。
3. 这个配置第一次用需要你本人在抖音网页扫码登录（搜索、评论等页面要求登录）。
   登录由你本人完成；本工作区不接触账号密码、验证码或 Cookie。

## 备选：装进你自己的 Edge

如果不想用独立配置，也可以手动装一次：

1. 地址栏输入 `edge://extensions`，打开 **开发人员模式**。
2. 点 **加载解压缩的扩展**，选择目录：
   `{{INSTALL_DIR}}\scripts\edge-bridge\extension`
3. 确认 **DSH Edge Bridge** 已启用。
   Edge 会提示“此扩展可读取和更改您访问的所有网站上的数据”，这是
   `chrome.debugger` 能力所需；本扩展只按 relay 指令执行只读 CDP 命令。

## 验证

```powershell
python scripts/edge-bridge/client.py status   # 期望 connected=true
python scripts/edge-bridge/client.py ping     # 期望 pong=true（UA 含 Edg/）
python scripts/edge-bridge/client.py tabs     # 列出 Edge 标签页
```

`status` 里 `connected=false` 或 `ping` 超时的处理顺序：

1. `relay` 是否在跑（8788 端口）：`Get-NetTCPConnection -LocalPort 8788`；
2. `edge://extensions` 里 DSH Edge Bridge 是否启用，必要时点“重新加载”；
3. Edge 是否完全关闭过 Service Worker（打开一次扩展页面或重开 Edge 会唤醒）。

## 用法

```powershell
python scripts/edge-bridge/client.py new-tab "https://www.douyin.com/"
python scripts/edge-bridge/client.py eval <tabId> --js "document.title"
python scripts/edge-bridge/client.py nav <tabId> "https://www.douyin.com/video/<作品ID>"
python scripts/edge-bridge/client.py shot <tabId> "batches/<批次ID>/assets/<文件名>.png"
python scripts/edge-bridge/client.py rpc send '{"tabId":123,"method":"Runtime.evaluate","params":{"expression":"location.href","returnByValue":true}}'
```

## 只读边界（不可放宽）

- 只读页面：DOM 读取、导航、滚动、截图；点击仅用于关闭弹窗/展开列表等必要场景。
- 不读取 Cookie、密码库、浏览历史数据库；不复制 Chrome 登录态。
- 密码、扫码、验证码、二次验证由用户本人完成；遇到风控/限流停下并报告。
- relay 无鉴权但只绑定 `127.0.0.1`；不用时关掉 relay 或停用扩展。
- 发布、评论私信、关注互动、投流、支付等外部操作需用户另行明确授权。

## 与 Chrome 版的关系

| | Chrome 版 | Edge 版（本目录） |
|---|---|---|
| 端口 | 127.0.0.1:8787 | 127.0.0.1:8788 |
| relay | DSH 桌面后台任务托管 | 本目录 relay.mjs，`start-relay.cmd` 启动 |
| 客户端 | `scripts/browser_bridge/client.py` | `scripts/edge-bridge/client.py` |
| 用途 | 自有账号（会话4） | 对标/参考研究（会话1/2） |

两套可以同时开着。不要把本目录的扩展再装进 Chrome（会多出一个消费者抢 8788 的命令）。
