# dsh-webctl

> 非官方工具：用 tmux 管理 DeepSeek Harness（DSH）Web UI 的后台生命周期，并提供一个可收藏、不含 token 的稳定短链。

[English README](../README.md)

`dsh web` 默认是前台进程，只监听 loopback，每次启动都会打印一个新的 token URL，终端关掉就退出。`dsh-webctl` 把它放进一个 detach 的 tmux 会话，捕获 token URL，并提供一个短链；短链每次都 302 到当前 token URL。

本项目与 DeepSeek 官方无关。

## 特性

- `start`、`stop`、`restart`、`status`、`url`、`short`、`logs`、`attach`
- 在 detach 的 tmux 会话里运行 DSH Web UI
- 从 DSH 日志里捕获 token URL
- 稳定短链：`http://<shortHost>:<shortPort>/`，URL 里不含 token
- 短链每次请求读取本地 state，302 到当前 token URL
- 拒绝启动第二个 `dsh web` 实例
- 运行时文件放在脚本旁边；脚本不写 `~/.dsh`
- 本地配置和运行时状态默认不进 git

## 要求

- Linux（脚本使用 `/proc` 和 tmux）
- Node.js >= 20.11
- tmux
- npx（随 npm/Node 提供；或配置 `npxPath`）
- DSH 包由 npx 拉取，不需要全局安装

## 快速开始

```bash
git clone https://github.com/Talyra42/dsh-webctl.git
cd dsh-webctl
cp dsh-web.config.example.json dsh-web.config.json

# 需要的话编辑 dsh-web.config.json；示例监听 127.0.0.1
node dsh-web.js start
```

典型输出：

```text
started tmux session "dsh-web"
short: http://127.0.0.1:8000/
http://127.0.0.1:3080/?token=...
logs:   node dsh-web.js logs -f
attach: tmux attach -t dsh-web
```

打开短链。它会跳转到 token URL，DSH 用 token 换到签名 cookie，之后直接访问 `http://127.0.0.1:3080/` 即可。

如果已经有一个手动启动的 `dsh web`，先停掉它；脚本会拒绝启动第二个实例。

可选：安装成本地命令：

```bash
npm link
dsh-webctl start
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `node dsh-web.js start` | 在 detach 的 tmux 会话里启动 DSH，并启动短链。如果会话已在运行，则补建短链并打印 URL。 |
| `node dsh-web.js stop` | 向会话发送 Ctrl+C，必要时 `kill-session`，停掉短链，清理 state。 |
| `node dsh-web.js restart` | 先 stop，再 start。 |
| `node dsh-web.js status` | 显示会话、pane、端口、token URL 和短链状态。 |
| `node dsh-web.js url` | 打印当前 token URL；把它当密码。 |
| `node dsh-web.js short` | 打印短链。 |
| `node dsh-web.js logs [-f] [lines]` | 查看 DSH 日志；`-f` 跟随。默认 `logTailLines` 行（120）。 |
| `node dsh-web.js attach` | 进入 tmux 会话。按 `Ctrl+B` 再按 `D` 退出。 |

## 配置

复制示例，并且不要把本地配置提交到 git：

```bash
cp dsh-web.config.example.json dsh-web.config.json
```

`dsh-web.config.json` 默认被 gitignore。脚本从自己所在目录读取配置，所以从哪个目录运行都可以。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 传给 `dsh web --host` 的地址。必须是具体的本机 IP；DSH 拒绝通配地址。 |
| `port` | `3080` | DSH Web UI 端口。 |
| `package` | `@deepseek-ai/dsh@latest` | 传给 npx 的包 spec。要可复现的启动就固定版本。 |
| `profile` | `web` | DSH profile。 |
| `cwd` | `~` | `dsh web` 进程的工作目录，也是新会话的默认工作区。 |
| `session` | `dsh-web` | tmux 会话名。 |
| `npxPath` | 空 | PATH 里找不到 npx 时，填绝对路径。 |
| `shortHost` | 空 | 短链监听地址。留空表示跟 `host` 一样。 |
| `shortPort` | `8000` | 短链端口，必须和 `port` 不同。 |
| `startTimeoutMs` | `120000` | 等待 DSH URL 的最长时间。 |
| `stopTimeoutMs` | `15000` | 发 Ctrl+C 后等待多久再 kill tmux 会话。 |
| `logTailLines` | `120` | `logs` 默认显示的行数。 |
| `extraArgs` | `[]` | 追加给 `dsh web` 的参数。 |

仅本机访问的示例：

```json
{
  "host": "127.0.0.1",
  "port": 3080,
  "shortPort": 8000
}
```

## 工作原理

1. `start` 检查是否已有 `dsh web`、DSH 和短链端口是否被占用、`cwd` 是否存在。
2. 创建 detach 的 tmux 会话，执行：

   ```text
   npx --yes <package> <profile> --host <host> --port <port> --no-open
   ```

   输出通过 `tee` 追加到 `.dsh-web/dsh-web.log`。
3. 脚本监听日志里的 `dsh web: <url>`，写入 `.dsh-web/state.json`。
4. 启动一个小重定向进程（`node dsh-web.js redirect`），绑定 `shortHost:shortPort`。每次请求读取 `state.json`，返回 `302` 到当前 token URL。
5. `stop` 向 pane 发 Ctrl+C，必要时 kill 会话，停掉重定向进程，清理 state。日志保留。

短链不是代理。302 之后浏览器直接连 DSH 服务器，重定向进程不再参与请求。

## 从虚拟机或其他机器访问

把 `host` 设成对方能访问到的本机地址。例如 VMware NAT 下，宿主机通常是 VMnet 网段的 `.1` 地址：

```json
{
  "host": "192.168.8.1",
  "port": 3080,
  "shortHost": "",
  "shortPort": 8000
}
```

`192.168.8.2` 是 NAT 设备，不是宿主机。短链会变成 `http://192.168.8.1:8000/`，宿主机和 guest 都能用。

不要绑 `0.0.0.0`：DSH 会拒绝通配地址，而且 token 和短链应该只留在可信网络上。如果宿主机还有别的网络，用防火墙限制端口来源。

## 安全

- token URL 是凭证，不要贴到聊天、提交或可分享的日志里。
- 短链是**无认证**的。任何能访问 `shortHost:shortPort` 的人都能拿到当前 token URL；只绑私有网络。
- state 和日志含 token URL。脚本创建 `.dsh-web/` 时权限为 `0700`，`state.json`/`dsh-web.log` 为 `0600`。
- `.dsh-web/` 和 `dsh-web.config.json` 已在 gitignore 里，不要提交。
- DSH agent 能执行你用户权限下的命令；浏览器或 VM 被控应视为宿主机安全问题。
- 本工具不迁移 DSH 的 profile/session。DSH 自己仍然使用 `~/.dsh`，只有本工具的运行时文件放在脚本旁边。

## 文件

```text
dsh-web.js
dsh-web.config.example.json
dsh-web.config.json        # 本地，gitignored
.dsh-web/state.json        # 0600
.dsh-web/dsh-web.log       # 0600
```

`state.json` 记录 tmux 会话/pane、当前 token URL、boot ID 和短链进程。`dsh-web.log` 包含 DSH 和短链输出，也包含 token URL。

## 故障排查

- **提示已有 `dsh web`**：先停掉手动启动的实例；脚本只管理自己的 tmux 会话。
- **短链端口被占用**：停掉占用进程，或改 `shortPort`。
- **第一次启动很慢**：`npx @latest` 可能需要解析并安装包到 npx 缓存；后续会快很多。要稳定可复现就固定 `package` 版本。
- **`npx not found`**：配置 `npxPath`。
- **短链 closed**：再执行一次 `start`，它会为已运行的 DSH 会话补建短链。
- **DSH 启动中退出**：执行 `logs`；启动失败时脚本也会打印日志尾部。

## 限制

- 仅 Linux；需要 tmux。
- 不随开机自启。需要的话，在图形会话启动后用 systemd user unit 执行同样的命令。
- 短链按设计没有认证，只适合 loopback 或可信的 VM 网络。
- 非 DeepSeek 官方项目。

## 许可证

MIT，见 [LICENSE](../LICENSE)。
