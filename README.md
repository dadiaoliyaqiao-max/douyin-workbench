# 抖音五模块工作台（家居家装行业版）

一套可直接发给同事的抖音运营工作流：**对标账号 → 参考视频 → 原创剧本 → 自有账号复盘 → 平台情报**。
五条链路共享统一规则、文件交接与浏览器自动化；总管聊天只负责协调、派工与验收。

> 适用：Windows 10/11 + DSH 桌面版（DeepSeek Harness）+ Microsoft Edge + Google Chrome。

## 一分钟了解

| 模块 | 做什么 |
|---|---|
| 会话1 对标账号 | 用 Edge 研究小号核验用户给的对标账号，出账号卡片、新增视频趋势、评论分析 |
| 会话2 参考视频 | 每轮 50 条：跨行业15 + 对标20 + 家居15；深拆必做豆包逐字稿；可加用户自选视频 |
| 会话3 原创剧本 | 按用户选片与要求写可拍剧本；演示只给分镜/口播/标题/封面；可继续“调整剧本” |
| 会话4 复盘 | 用 Chrome 运营账号读后台数据，做逐条诊断＋对标/参考/情报三项对照 |
| 会话5 情报 | 抖音规则/功能/案例情报，每条带来源链接，顶部给总体分析与建议 |

## 安装（把一句指令发给 DSH 即可）

新开一个 DSH 聊天，把下面整段复制发给它：

```text
请帮我安装「抖音五模块工作台」：
1. 从 GitHub 公开仓库 https://github.com/dadiaoliyaqiao-max/douyin-workbench 克隆到 D:\DouyinWorkbench；如果目录已存在，先备份 data、batches、research、reviews、scripts-output 再更新。
2. 运行 install.ps1（PowerShell，自动检测 DSH / Edge / Chrome / Node / Python，装好两个浏览器扩展，并把桥接服务设为开机启动）。
3. 安装完成后检查 Edge 8788 和 Chrome 8787 两个桥接是否连通，告诉我两个桌面快捷方式怎么登录。
4. 再引导我在 DSH 新建 5 个工作聊天并运行 configure-sessions.ps1 绑定会话。
5. 不要读取或上传任何密码、Cookie；缺 DSH / Node / Python 时停下告诉我缺什么。
```

安装脚本会自动：
- 检测 Windows / DSH / Edge / Chrome / Node / Python；
- 复制程序到安装目录（默认 `%USERPROFILE%\DouyinWorkbench`）；
- 创建两个桌面浏览器快捷方式，**自动加载 Edge / Chrome 扩展**，并使用独立配置目录；
- 把本机桥接服务加入开机启动（Edge 8788 / Chrome 8787）；
- 初始化空的对标账号库与业务档案；
- 注册 DSH 五模块侧栏插件（默认关闭，可在 `configure-sessions.ps1` 绑定会话后启用）。

> 如果 DSH 不能执行命令，才需要从 Releases 下载 ZIP 手动解压并右键运行 `install.ps1`。

## 安装后

- **Edge 研究浏览器**：登录抖音**研究小号**，用于会话1/2/5。
- **Chrome 运营浏览器**：登录**运营账号**，用于会话4。
- 在 DSH 新建 6 个聊天（总管 + 5 个模块），把 `会话说明/` 里的启动语分别发给对应聊天。
- **对标账号由用户自己提供**：直接发账号名称/抖音号/主页链接给会话1；安装包不预置任何账号。

极简使用说明（带按钮截图）见 **[tutorial.html](tutorial.html)**；完整安装/命令/FAQ 存档在 `docs/详细安装手册.html`。

## 目录

```
install.ps1 / configure-sessions.ps1 / tutorial.html
AGENTS.md                 总规则
会话说明/                 5 个模块启动说明
docs/                     筛选、登录、逐字稿、报告、复盘、情报等细则
config/ data/             配置与业务数据（空模板）
scripts/                  批次工具、浏览器桥接、五会话调度、侧栏插件
extensions/               Edge / Chrome 扩展（安装脚本自动加载）
bin/                      启动/停止桥接
batches/ research/ reviews/ scripts-output/   运行后产生的业务数据
```

## 安全边界

- 不保存抖音密码，不读取 Cookie/密码库；登录由本人扫码完成。
- 浏览器与桥接默认只读；发布、私信、关注、投流、支付等外部操作必须另行明确授权。
- 报告、截图、逐字稿等数据保存在本机；**不要把 `batches/ research/ reviews/ data/` 提交到公开仓库**。

## 许可

仅供团队内部使用；第三方平台内容（视频、评论、截图）版权归原作者，项目中保存的仅用于研究分析。
