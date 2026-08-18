<div align="center">

<img src="public/codex-bridge-c.svg" width="96" height="96" alt="Codex Bridge">

# Codex Bridge

**把运行在 Windows 或 macOS 上的 Codex，带到 Android 手机上。**

在手机上查看任务、继续对话、处理审批和控制运行状态，实际执行仍留在自己的电脑。

[![Release](https://img.shields.io/github/v/release/momo-888/codex-bridge?style=flat-square)](https://github.com/momo-888/codex-bridge/releases/latest)
[![CI](https://github.com/momo-888/codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/momo-888/codex-bridge/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/momo-888/codex-bridge/total?style=flat-square)](https://github.com/momo-888/codex-bridge/releases)
[![License](https://img.shields.io/github/license/momo-888/codex-bridge?style=flat-square)](LICENSE)

[⬇️ 下载](https://github.com/momo-888/codex-bridge/releases/latest) · [🚀 快速开始](#下载即用) · [✨ 功能](#功能) · [🛡️ 安全说明](#安全边界)

</div>

<p align="center">
  <a href="docs/screenshots/home.png"><img src="docs/screenshots/home.png" width="31%" alt="Codex Bridge 首页"></a>
  <a href="docs/screenshots/task.png"><img src="docs/screenshots/task.png" width="31%" alt="Codex Bridge 当前任务"></a>
  <a href="docs/screenshots/workspaces.png"><img src="docs/screenshots/workspaces.png" width="31%" alt="Codex Bridge 工作区"></a>
</p>

<p align="center"><sub>首页 · 实时任务与过程更新 · 工作区</sub></p>

## 下载即用

普通用户不需要克隆仓库，也不需要安装 Node.js：

1. 从 [GitHub Releases](https://github.com/momo-888/codex-bridge/releases) 下载 Windows 安装程序，或下载并解压 `CodexBridge-macOS-arm64.zip` 后运行 `scripts/install-macos.sh`。
2. 从同一 Release 下载 `CodexBridge.apk` 并安装到 Android 手机。
3. 在 Windows 托盘菜单或 macOS 浏览器管理页中选择仅本机、局域网 / 异地组网或公网中继，并复制显示的地址。
4. 在手机输入该地址并发送连接请求；核对电脑弹窗中的设备名与来源 IP 后选择允许。

`CodexBridge-Windows-Portable.zip` 适合不希望安装的 Windows 用户：解压后直接运行根目录的 `CodexBridge.exe`。Windows 和 macOS 发布包均包含运行时；只有源码开发和自行构建才需要 Node.js/npm。

如果手机和电脑不在同一局域网，推荐使用 [Linker](https://github.com/snltty/linker) / [Tailscale](https://tailscale.com/) 等可信异地组网的电脑 IP。不要把未加密的 Host 端口直接映射到公网；公网访问应使用自行部署的 HTTPS/WSS Relay。

需要公网中继时，可从同一 Release 下载 `CodexBridge-Relay-Deploy.zip`。部署完成后，在电脑管理界面选择“公网中继”，填写中继地址、Host Token 和 Phone Token 即可；无需重新编译桌面端或 Android 客户端。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属、合作或背书关系。Codex 和 OpenAI 是其各自权利人的商标。

## 功能

- 读取 Codex Desktop 中的工作区、历史任务和回合内容
- 从手机继续同一个任务，并实时查看增量输出和过程更新
- 新建任务、创建文件夹、选择模型、推理强度与权限模式
- 发送图片、引用电脑文件/文件夹、处理 Bridge 发起的审批
- 排队发送、取消排队、停止正在执行的手机任务
- Android 扫码配对、原生通知和支持双指缩放的图片查看器
- 通过可信异地组网直连，或自建 HTTPS/WSS Relay

## 架构

```text
Android / PWA
      │
      ├── Linker / Tailscale HTTP/WS ──────────┐
      │                                        │
      └── HTTPS/WSS ── self-hosted Relay ──────┤
                                               ▼
                                      Windows / macOS Host
                                               │
                                               ├── Codex App Server
                                               ├── ~/.codex history
                                               └── Codex Desktop integration
```

桌面版和 Bridge 是两个 App Server 客户端。Bridge 会识别桌面正在执行的回合并避免并发写入；手机消息可以进入持久化队列，等桌面回合完成后再发送。

## 安全边界

Codex Bridge 面向单用户、自托管场景，不是多租户服务：

- 配对令牌具有读取任务、发送消息和触发本机 Codex 操作的能力，应当像密码一样保护。
- 当前没有端到端加密。HTTPS Relay 会在服务器端终止 TLS，因此 Relay 管理者能够接触转发的数据。
- Android 允许 HTTP，是为了兼容已经提供链路加密的可信异地组网；不要把 HTTP Host 端口直接暴露到公网。
- 全新安装默认仅监听 `127.0.0.1`。局域网或异地组网访问必须显式指定 `-ListenAddress 0.0.0.0`。

完整威胁模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 环境要求

- Windows 10/11，或 macOS 13 及更高版本
- Node.js 22.13 或更高版本（仅源码开发或自行构建需要；Release Windows 包已内置）
- 已安装并登录、能够正常运行任务的 Codex Desktop
- Android 8.0 或更高版本（使用 APK 时）
- PowerShell 5.1 或更高版本（仅 Windows 脚本）

## Windows Host

克隆仓库后进入项目目录：

```powershell
git clone https://github.com/momo-888/codex-bridge.git
cd codex-bridge
npm ci
npm run typecheck
npm test
```

### 仅本机运行

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

配对页位于 `http://127.0.0.1:43110/setup`。该模式不会接受其他设备的连接。

### Linker / Tailscale 异地组网或局域网

下面示例假设电脑在组网中的地址是 `100.64.0.10`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 `
  -ListenAddress 0.0.0.0 `
  -PublicHost 100.64.0.10
```

只允许可信私有网络访问 TCP `43110`，不要在路由器上将该端口映射到公网。

### 已有 HTTPS 反向代理

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 `
  -ListenAddress 0.0.0.0 `
  -PublicUrl "https://bridge.example.com"
```

`PublicUrl` 只声明手机应该访问的外部地址；证书、DNS 和反向代理仍需自行配置。

如果希望配对页显示一个由你维护的正式 APK 下载地址，可在 Host 环境中设置 `CODEX_BRIDGE_APK_URL`。默认不会从源码目录分发本地 APK。

### 常用命令

```powershell
.\scripts\start-codex-bridge.ps1
.\scripts\stop-codex-bridge.ps1
.\scripts\uninstall-startup.ps1
```

运行日志位于项目的 `.logs`；本地配置、令牌、队列和诊断记录位于 `%USERPROFILE%\.codex-bridge`，这些目录均不会提交到 Git。

## macOS Host（浏览器管理模式）

macOS 端不需要额外的原生客户端。后台 Supervisor 负责 Host、Codex、手机 Web 和 Relay 的健康检查、异常恢复与 Codex 更新后重启；管理页面只监听 `127.0.0.1:43109`。

源码安装：

```bash
git clone https://github.com/momo-888/codex-bridge.git
cd codex-bridge
./scripts/install-macos.sh
```

脚本会安装依赖、构建网页、注册当前用户的 LaunchAgent，并打开管理页。发布包已经内置 Node 运行时，解压后执行相同命令即可；它会复制到 `~/Applications/CodexBridge` 后安装。常用命令：

```bash
./scripts/run-macos.sh          # 前台运行管理服务
./scripts/start-codex-bridge.sh # 仅启动 Host/Web
./scripts/stop-codex-bridge.sh
./scripts/uninstall-macos.sh
```

管理页支持三种连接模式、Relay 连通性测试、启动/停止/重启、详细健康状态、配对允许/拒绝和日志查看。新配对请求也会弹出 macOS 原生确认框。配置与令牌位于 `~/.codex-bridge`（目录权限 `0700`、敏感文件 `0600`），运行日志位于项目 `.logs`。

自行生成 macOS 发布包：

```bash
./scripts/build-macos-release.sh
```

输出位于 `outputs/macos-release`，包名包含当前构建架构。

## 自建 Relay

Relay 需要独立的 Host Token 和 Phone Token，两个值都至少包含 32 个随机字符。示例配置位于 [`deploy/relay/.env.example`](deploy/relay/.env.example)。

普通用户可以直接从 GitHub Release 下载 `CodexBridge-Relay-Deploy.zip`，按照包内 `deploy/relay/README.md` 使用 Docker Compose 部署，并在桌面托盘中完成连接配置。下面是源码开发环境中的等价流程。

生成部署包和随机令牌：

```powershell
.\scripts\prepare-relay-deployment.ps1 -PublicUrl "https://bridge.example.com"
```

将 `.deploy/codex-bridge-relay.tar.gz`、`%USERPROFILE%\.codex-bridge\relay-server.env` 和 `deploy/relay/install-server.sh` 复制到 Linux 服务器后，以 root 执行安装脚本。Nginx 示例中的 `bridge.example.com` 必须替换成自己的域名。

电脑只会向 Relay 建立出站 WSS 连接，家庭网络无需开放入站端口。验证部署：

```powershell
node .\scripts\verify-public-relay.mjs https://bridge.example.com
```

## Android

首次构建会在忽略目录 `.tools` 中准备 Android 工具链。普通开发包使用 Android Debug 签名：

```powershell
.\scripts\build-android.ps1 -BridgeUrl "https://bridge.example.com"
```

输出位于 `outputs/android/CodexBridge-debug.apk`，不会进入 Git 历史。

正式发布必须提供自己的签名密钥：

```powershell
$env:CODEX_BRIDGE_KEYSTORE_PATH = "C:\secure\release.keystore"
$env:CODEX_BRIDGE_KEYSTORE_PASSWORD = "..."
$env:CODEX_BRIDGE_KEY_ALIAS = "..."
$env:CODEX_BRIDGE_KEY_PASSWORD = "..."
.\scripts\build-android.ps1 -Variant Release -BridgeUrl "https://bridge.example.com"
```

构建脚本会输出 APK 路径和 SHA-256。推荐将正式 APK 作为 GitHub Release 附件发布，不要提交到仓库。

## 开发与验证

```bash
npm run dev
npm run host
npm run typecheck
npm run lint
npm test
npm run icons
```

按需生成当前 Codex 版本的协议类型和 JSON Schema：

```powershell
.\scripts\generate-protocol.ps1
```

结果位于忽略目录 `.tmp-appserver-schema`，不提交一次性生成快照。调整 App Server 兼容逻辑时，应在 Pull Request 中说明测试使用的 Codex 版本。

## 当前限制

- macOS 发布包按构建机器架构生成；Intel 与 Apple Silicon 需要分别构建。
- 公网 Relay 不提供端到端加密。
- Desktop 正在执行的回合仍归 Desktop 所有，相关审批需要在电脑端完成。
- App Server 协议会随 Codex 更新；升级 Codex 后应执行完整回归测试。

## 参与贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。提交问题时不要上传真实配对码、令牌、个人目录截图或 Codex 私密对话。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。第三方说明见 [NOTICE](NOTICE)。
