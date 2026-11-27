# dsh-webctl

> Unofficial tmux-based lifecycle manager for the DeepSeek Harness (DSH) Web UI — with a stable, token-free short link.

[中文说明](docs/README.zh-CN.md)

`dsh web` is a foreground process. It binds to loopback by default, prints a new
token URL on every start, and stops when its terminal closes. `dsh-webctl` wraps
it in a detached tmux session, captures the token URL, and gives you a
bookmarkable short URL that always redirects to the current token URL.

This project is not affiliated with DeepSeek.

## Features

- `start`, `stop`, `restart`, `status`, `url`, `short`, `logs`, `attach`
- Runs the DSH Web UI in a detached tmux session
- Captures the token URL from the DSH log
- Stable short link: `http://<shortHost>:<shortPort>/` (no token in the URL)
- The short link reads the current token URL from local state on every request
- Refuses to start a second `dsh web` instance
- Runtime files live next to the script; the script does not write to `~/.dsh`
- Local config and runtime state are gitignored

## Requirements

- Linux (the script uses `/proc` and tmux)
- Node.js >= 20.11
- tmux
- npx (shipped with npm/Node; or set `npxPath`)
- The DSH package is fetched by npx; no global install is required

## Quick start

```bash
git clone https://github.com/Talyra42/dsh-webctl.git
cd dsh-webctl
cp dsh-web.config.example.json dsh-web.config.json

# Edit dsh-web.config.json if needed. The example listens on 127.0.0.1.
node dsh-web.js start
```

Typical output:

```text
started tmux session "dsh-web"
short: http://127.0.0.1:8000/
http://127.0.0.1:3080/?token=...
logs:   node dsh-web.js logs -f
attach: tmux attach -t dsh-web
```

Open the short URL. It redirects to the token URL, the DSH server exchanges the
token for a signed session cookie, and the clean `http://127.0.0.1:3080/`
works from then on.

If another `dsh web` is already running, stop it first. The script intentionally
refuses to start a second instance.

This project is distributed as source only; there is no npm package. `npm link`
is optional and only symlinks this checkout into your global bin:

```bash
npm link
dsh-webctl start
```

Remove it with `npm unlink -g dsh-webctl`. If you prefer no global command at
all, keep using `node dsh-web.js ...`.

## Commands

| Command | Description |
| --- | --- |
| `node dsh-web.js start` | Start DSH in a detached tmux session and start the short link. If the session is already running, ensure the short link and print the URLs. |
| `node dsh-web.js stop` | Send Ctrl+C to the session, fall back to `kill-session`, stop the short link, and remove state. |
| `node dsh-web.js restart` | Stop, then start. |
| `node dsh-web.js status` | Show session, pane, ports, the token URL, and the short link. |
| `node dsh-web.js url` | Print the current token URL. Treat it as a secret. |
| `node dsh-web.js short` | Print the token-free short URL. |
| `node dsh-web.js logs [-f] [lines]` | Show the DSH log; `-f` follows it. Default is `logTailLines` (120). |
| `node dsh-web.js attach` | Attach to the tmux session. Detach with `Ctrl+B`, then `D`. |

## Configuration

Copy the example and keep your local config out of git:

```bash
cp dsh-web.config.example.json dsh-web.config.json
```

`dsh-web.config.json` is gitignored. The script reads it from its own directory,
so it works from any current working directory.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Address passed to `dsh web --host`. Must be a concrete local IP; wildcard addresses are rejected by DSH. |
| `port` | `3080` | DSH Web UI port. |
| `package` | `@deepseek-ai/dsh@latest` | Package spec passed to npx. Pin a version for reproducible starts. |
| `profile` | `web` | DSH profile. |
| `cwd` | `~` | Working directory of the `dsh web` process; the default workspace for new sessions. |
| `session` | `dsh-web` | tmux session name. |
| `npxPath` | empty | Optional absolute path to npx when PATH does not contain it. |
| `shortHost` | empty | Address for the short link. Empty means use `host`. |
| `shortPort` | `8000` | Port for the short link. Must differ from `port`. |
| `startTimeoutMs` | `120000` | How long to wait for the DSH URL. |
| `stopTimeoutMs` | `15000` | How long to wait for Ctrl+C before killing the tmux session. |
| `logTailLines` | `120` | Default number of lines for `logs`. |
| `extraArgs` | `[]` | Extra arguments appended to the `dsh web` command. |

Example for local-only access:

```json
{
  "host": "127.0.0.1",
  "port": 3080,
  "shortPort": 8000
}
```

## How it works

1. `start` checks for another `dsh web` process, checks the DSH and short-link
   ports, and verifies `cwd`.
2. It creates a detached tmux session and runs:

   ```text
   npx --yes <package> <profile> --host <host> --port <port> --no-open
   ```

   Output is appended to `.dsh-web/dsh-web.log` through `tee`.
3. The script watches the log for the `dsh web: <url>` line and writes
   `.dsh-web/state.json`.
4. It starts a small redirect process (`node dsh-web.js redirect`) that binds
   `shortHost:shortPort`. Every request reads `state.json` and returns a `302`
   to the current token URL.
5. `stop` sends Ctrl+C to the pane, kills the session if necessary, stops the
   redirect process, and removes state. The log is kept.

The short link is not a proxy. After the 302, the browser talks directly to the
DSH server; the redirect process is no longer in the request path.

## Access from a VM or another machine

Set `host` to a concrete address on the host that the other machine can reach.
For example, with VMware NAT the host side is usually the `.1` address of the
VMnet subnet:

```json
{
  "host": "192.168.8.1",
  "port": 3080,
  "shortHost": "",
  "shortPort": 8000
}
```

`192.168.8.2` is the NAT device, not the host. The short link becomes
`http://192.168.8.1:8000/`. Both the host and the guest can use that URL.

Do not bind `0.0.0.0`: DSH rejects wildcard addresses, and the token/short link
should stay on a trusted interface. Restrict the ports at the firewall if the
host has other networks.

## Security

- The token URL is a credential. Do not paste it into chats, commits, or logs
  you share.
- The short link is unauthenticated. Anyone who can reach `shortHost:shortPort`
  can obtain the current token URL. Bind it to a private interface only.
- State and log files contain token URLs. The script creates `.dsh-web/` with
  mode `0700` and `state.json`/`dsh-web.log` with mode `0600`.
- `.dsh-web/` and `dsh-web.config.json` are gitignored. Keep them out of the
  repository.
- The DSH agent can run tools with your user's permissions. A compromised
  browser or VM should be treated as a host-security problem.
- This tool does not move DSH's profile or session data. DSH itself still uses
  `~/.dsh`; only this tool's runtime files stay next to the script.

## Files

```text
dsh-web.js
dsh-web.config.example.json
dsh-web.config.json        # local, gitignored
.dsh-web/state.json        # 0600
.dsh-web/dsh-web.log       # 0600
```

`state.json` records the tmux session/pane, the current token URL, the boot ID,
and the short-link process. `dsh-web.log` contains the DSH and short-link
output, including token URLs.

## Troubleshooting

- **"another dsh web process is already running"** — stop the manually started
  DSH first. The script only manages its own tmux session.
- **Short port already in use** — stop the process using it or change
  `shortPort`.
- **The first start is slow** — `npx @latest` may need to resolve and install
  the package into the npx cache. Later starts are usually much faster. Pin
  `package` if you want reproducible, cache-friendly starts.
- **`npx not found`** — set `npxPath` to the absolute npx path.
- **Short link is closed** — run `start` again; it re-creates the redirect for
  an already running DSH session.
- **DSH exited during startup** — run `logs`; the tail of the log is printed on
  failure too.

## Limitations

- Linux only; tmux is required.
- No boot-time persistence. If you need that, run the same command from a
  systemd user unit after the graphical session starts.
- The short link has no authentication by design; it is meant for a trusted
  loopback or VM network.
- Not an official DeepSeek project.

## License

MIT. See [LICENSE](LICENSE).
