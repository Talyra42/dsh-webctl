#!/usr/bin/env node
/**
 * dsh-web.js — run the DSH Web UI in a detached tmux session.
 *
 * All runtime files stay next to this script:
 *   .dsh-web/state.json    session/pane/url/start metadata
 *   .dsh-web/dsh-web.log   stdout+stderr of `dsh web`
 *
 * Commands: start, stop, restart, status, url, logs [-f] [lines], attach
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_DIR = import.meta.dirname;
const CONFIG_PATH = path.join(SCRIPT_DIR, 'dsh-web.config.json');
const STATE_DIR = path.join(SCRIPT_DIR, '.dsh-web');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const LOG_PATH = path.join(STATE_DIR, 'dsh-web.log');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3080,
  package: '@deepseek-ai/dsh@latest',
  profile: 'web',
  cwd: os.homedir(),
  session: 'dsh-web',
  npxPath: '',
  shortHost: '',
  shortPort: 8000,
  startTimeoutMs: 120_000,
  stopTimeoutMs: 15_000,
  logTailLines: 120,
  extraArgs: [],
};

function fail(message) {
  throw new Error(message);
}

function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    let text;
    try {
      text = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (error) {
      fail(`cannot read ${CONFIG_PATH}: ${error.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      fail(`invalid JSON in ${CONFIG_PATH}: ${error.message}`);
    }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`config must be a JSON object: ${CONFIG_PATH}`);
  }

  const cfg = { ...DEFAULTS, ...raw };

  if (typeof cfg.host !== 'string' || cfg.host.trim() === '') fail('config.host must be a non-empty string');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) fail('config.port must be an integer in 1..65535');
  if (typeof cfg.package !== 'string' || cfg.package.trim() === '') fail('config.package must be a non-empty string');
  if (typeof cfg.profile !== 'string' || cfg.profile.trim() === '') fail('config.profile must be a non-empty string');
  if (typeof cfg.session !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cfg.session)) fail('config.session must match [A-Za-z0-9_-]+');
  if (typeof cfg.cwd !== 'string' || cfg.cwd.trim() === '') fail('config.cwd must be a non-empty string');
  if (typeof cfg.npxPath !== 'string') fail('config.npxPath must be a string');
  if (typeof cfg.shortHost !== 'string') fail('config.shortHost must be a string');
  if (!Number.isInteger(cfg.shortPort) || cfg.shortPort < 1 || cfg.shortPort > 65535) fail('config.shortPort must be an integer in 1..65535');
  if (cfg.shortPort === cfg.port) fail('config.shortPort must differ from config.port');
  if (!Number.isInteger(cfg.startTimeoutMs) || cfg.startTimeoutMs < 1000) fail('config.startTimeoutMs must be an integer >= 1000');
  if (!Number.isInteger(cfg.stopTimeoutMs) || cfg.stopTimeoutMs < 1000) fail('config.stopTimeoutMs must be an integer >= 1000');
  if (!Number.isInteger(cfg.logTailLines) || cfg.logTailLines < 1) fail('config.logTailLines must be a positive integer');
  if (!Array.isArray(cfg.extraArgs) || cfg.extraArgs.some((item) => typeof item !== 'string')) fail('config.extraArgs must be an array of strings');

  cfg.host = cfg.host.trim();
  cfg.package = cfg.package.trim();
  cfg.profile = cfg.profile.trim();
  cfg.shortHost = cfg.shortHost.trim();

  let cwd = cfg.cwd;
  if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1));
  cfg.cwd = path.resolve(SCRIPT_DIR, cwd);

  return cfg;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '', { mode: 0o600 });
  }
  try {
    fs.chmodSync(LOG_PATH, 0o600);
  } catch {}
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  let text;
  try {
    text = fs.readFileSync(STATE_PATH, 'utf8');
  } catch (error) {
    fail(`cannot read ${STATE_PATH}: ${error.message}`);
  }
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON in ${STATE_PATH}: ${error.message}`);
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}

function removeState() {
  try {
    fs.rmSync(STATE_PATH, { force: true });
  } catch {}
}

function tmux(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.error) fail(`tmux: ${result.error.message}`);
  return result;
}

function hasSession(session) {
  return tmux(['has-session', '-t', `=${session}`]).status === 0;
}

function sessionPaneInfo(session) {
  const result = tmux(['list-panes', '-t', `=${session}`, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_dead}']);
  if (result.status !== 0) return null;
  const line = result.stdout.split('\n').find((item) => item.trim() !== '');
  if (!line) return null;
  const [id, pidText, deadText] = line.split('\t');
  const pid = Number(pidText);
  return {
    id: id || null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    dead: deadText === '1',
  };
}

function setSessionOptions(session) {
  // Best effort: keep the detached session alive and close it when the server exits.
  tmux(['set-option', '-t', session, 'destroy-unattached', 'off']);
  tmux(['set-option', '-t', session, 'remain-on-exit', 'off']);
}

function sendCtrlC(target) {
  tmux(['send-keys', '-t', target, 'C-c']);
}

function killSession(session) {
  tmux(['kill-session', '-t', `=${session}`]);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function findUrl(text) {
  const clean = stripAnsi(text);
  const line = clean.match(/(?:^|\n)dsh web:\s*(https?:\/\/\S+)/);
  if (line) return line[1];
  const fallback = clean.match(/(https?:\/\/[^\s]+\?token=[^\s]+)/);
  return fallback ? fallback[1] : null;
}

function readChunk(offset) {
  const buffer = fs.readFileSync(LOG_PATH);
  const start = offset > buffer.length ? 0 : offset;
  return { text: buffer.subarray(start).toString('utf8'), size: buffer.length };
}

function tail(file, lines) {
  const result = spawnSync('tail', ['-n', String(lines), file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return '';
  return result.stdout;
}

function isPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      resolve(value);
    };
    try {
      socket = net.connect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function currentBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

function shortBindHost(cfg) {
  return cfg.shortHost || cfg.host;
}

function shortUrlOf(cfg) {
  return `http://${shortBindHost(cfg)}:${cfg.shortPort}/`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOurRedirect(pid) {
  if (!isPidAlive(pid)) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('dsh-web.js') && cmdline.includes('redirect');
  } catch {
    return false;
  }
}

async function stopShort(state) {
  const pid = state?.shortPid;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (state?.bootId && state.bootId !== currentBootId()) return true;
  if (!isOurRedirect(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
  return !isPidAlive(pid);
}

async function startShort(cfg, state) {
  ensureStateDir();
  const host = shortBindHost(cfg);
  const port = cfg.shortPort;
  const url = shortUrlOf(cfg);
  const sameBoot = !state?.bootId || state.bootId === currentBootId();

  if (state?.shortPid && sameBoot && isOurRedirect(state.shortPid)) {
    if (await isPortOpen(host, port)) {
      return { pid: state.shortPid, url, reused: true };
    }
    await stopShort(state);
  }

  if (await isPortOpen(host, port)) {
    fail(`short port ${host}:${port} is already in use; stop it or change config.shortPort`);
  }

  const logFd = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, 'dsh-web.js'), 'redirect'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: SCRIPT_DIR,
  });
  fs.closeSync(logFd);
  child.unref();

  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) {
      return { pid: child.pid, url, reused: false };
    }
    if (spawnError || child.exitCode !== null) break;
    await sleep(100);
  }

  try {
    process.kill(child.pid, 'SIGTERM');
  } catch {}
  fail(`short redirect failed to start; check ${LOG_PATH}\n${tail(LOG_PATH, 20)}`);
}

function scanDshWeb() {
  const self = process.pid;
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self) continue;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const args = raw.split('\0').filter(Boolean);
    if (!args.includes('web')) continue;
    const isDsh = args.some((arg) => arg === 'dsh' || arg.endsWith('/dsh') || arg.includes('@deepseek-ai/dsh'));
    if (!isDsh) continue;
    found.push({ pid, cmd: args.join(' ') });
  }
  return found;
}

function resolveNpx(cfg) {
  if (cfg.npxPath) {
    const candidate = path.resolve(SCRIPT_DIR, cfg.npxPath);
    if (!fs.existsSync(candidate)) fail(`config.npxPath does not exist: ${candidate}`);
    return candidate;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'npx');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  fail('npx not found in PATH; set config.npxPath');
}

function buildCommand(cfg, npx) {
  const pathValue = [
    path.dirname(process.execPath),
    path.dirname(npx),
    process.env.PATH || '',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean).join(path.delimiter);

  const args = [
    npx,
    '--yes',
    cfg.package,
    cfg.profile,
    '--host', cfg.host,
    '--port', String(cfg.port),
    '--no-open',
    ...cfg.extraArgs,
  ];

  return `export PATH=${shQuote(pathValue)}; ${args.map(shQuote).join(' ')} 2>&1 | tee -a ${shQuote(LOG_PATH)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(cfg) {
  ensureStateDir();
  const state = readState();

  if (state?.session && state.session !== cfg.session && hasSession(state.session)) {
    fail(`state belongs to tmux session "${state.session}", but config.session is "${cfg.session}"; stop the old session first`);
  }

  if (hasSession(cfg.session)) {
    if (state?.session === cfg.session) {
      const pane = sessionPaneInfo(cfg.session);
      if (state.panePid && pane?.pid && state.panePid !== pane.pid) {
        fail(`tmux session "${cfg.session}" exists but its pane changed (${state.panePid} -> ${pane.pid}); refusing to treat it as ours`);
      }
      if (!state.bootId) state.bootId = currentBootId();
      try {
        const short = await startShort(cfg, state);
        state.shortPid = short.pid;
        state.shortUrl = short.url;
        writeState(state);
      } catch (error) {
        console.error(`warning: short redirect not started: ${error.message}`);
      }
      console.log(`already running: tmux session "${cfg.session}"`);
      if (state.shortUrl) console.log(`short: ${state.shortUrl}`);
      if (state.url) console.log(state.url);
      console.log(`logs: node ${path.basename(process.argv[1])} logs -f`);
      return 0;
    }
    fail(`tmux session "${cfg.session}" already exists but is not managed by this script; attach or kill it first`);
  }

  const others = scanDshWeb();
  if (others.length > 0) {
    const list = others.slice(0, 5).map((item) => `  PID ${item.pid}: ${item.cmd}`).join('\n');
    fail(`another dsh web process is already running:\n${list}\nstop it first; this script only manages its own tmux session`);
  }

  if (await isPortOpen(cfg.host, cfg.port)) {
    fail(`${cfg.host}:${cfg.port} is already listening; stop whatever owns it first`);
  }

  const shortHost = shortBindHost(cfg);
  const sameBoot = !state?.bootId || state.bootId === currentBootId();
  const shortReusable = Boolean(state?.shortPid && sameBoot && isOurRedirect(state.shortPid));
  if (!shortReusable && await isPortOpen(shortHost, cfg.shortPort)) {
    fail(`short port ${shortHost}:${cfg.shortPort} is already in use; stop it or change config.shortPort`);
  }

  if (!fs.existsSync(cfg.cwd) || !fs.statSync(cfg.cwd).isDirectory()) {
    fail(`config.cwd is not a directory: ${cfg.cwd}`);
  }

  const npx = resolveNpx(cfg);
  const command = buildCommand(cfg, npx);
  const offset = fs.statSync(LOG_PATH).size;

  const launched = tmux([
    'new-session', '-d',
    '-s', cfg.session,
    '-c', cfg.cwd,
    '--', '/bin/bash', '-c', command,
  ]);
  if (launched.status !== 0) {
    fail(`tmux new-session failed: ${(launched.stderr || '').trim() || `exit ${launched.status}`}`);
  }

  setSessionOptions(cfg.session);
  const pane = sessionPaneInfo(cfg.session);

  let url = null;
  let finalState = null;
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    try {
      killSession(cfg.session);
    } catch {}
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  try {
    const deadline = Date.now() + cfg.startTimeoutMs;
    while (Date.now() < deadline) {
      const chunk = readChunk(offset);
      url = findUrl(chunk.text);
      if (url) break;

      const current = sessionPaneInfo(cfg.session);
      if (!current) {
        fail(`dsh web exited during startup\n${tail(LOG_PATH, 40)}`);
      }
      if (current.dead) {
        fail(`dsh web exited during startup (dead pane)\n${tail(LOG_PATH, 40)}`);
      }
      await sleep(200);
    }
    if (!url) {
      fail(`timed out after ${cfg.startTimeoutMs}ms waiting for the URL\n${tail(LOG_PATH, 40)}`);
    }

    const nextState = {
      session: cfg.session,
      paneId: pane?.id ?? null,
      panePid: pane?.pid ?? null,
      url,
      host: cfg.host,
      port: cfg.port,
      cwd: cfg.cwd,
      package: cfg.package,
      bootId: currentBootId(),
      startedAt: new Date().toISOString(),
    };
    if (shortReusable) nextState.shortPid = state.shortPid;
    writeState(nextState);

    try {
      const short = await startShort(cfg, nextState);
      nextState.shortPid = short.pid;
      nextState.shortUrl = short.url;
      try {
        writeState(nextState);
      } catch (error) {
        await stopShort(nextState);
        throw error;
      }
    } catch (error) {
      console.error(`warning: short redirect not started: ${error.message}`);
    }
    finalState = nextState;
  } catch (error) {
    if (!interrupted) {
      try {
        if (hasSession(cfg.session)) killSession(cfg.session);
      } catch {}
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  console.log(`started tmux session "${cfg.session}"`);
  if (finalState?.shortUrl) console.log(`short: ${finalState.shortUrl}`);
  console.log(url);
  console.log(`logs:   node ${path.basename(process.argv[1])} logs -f`);
  console.log(`attach: tmux attach -t ${cfg.session}`);
  return 0;
}

async function stop(cfg) {
  const state = readState();

  if (!state) {
    if (hasSession(cfg.session)) {
      fail(`tmux session "${cfg.session}" exists but there is no state file; not managed by this script. Attach or kill it manually.`);
    }
    console.log('not running');
    return 0;
  }

  const session = state.session || cfg.session;
  if (!hasSession(session)) {
    const shortOk = await stopShort(state);
    removeState();
    console.log(`not running (removed stale state${shortOk ? '' : '; warning: short redirect may still be running'})`);
    return 0;
  }

  const pane = sessionPaneInfo(session);
  if (state.panePid && pane?.pid && state.panePid !== pane.pid) {
    fail(`tmux session "${session}" now has pane ${pane.pid}, expected ${state.panePid}; refusing to stop it`);
  }

  if (pane?.dead) {
    killSession(session);
  } else {
    sendCtrlC(pane?.id || state.paneId || session);
  }

  const deadline = Date.now() + cfg.stopTimeoutMs;
  while (Date.now() < deadline) {
    if (!hasSession(session)) {
      const shortOk = await stopShort(state);
      removeState();
      console.log(`stopped (${session}${shortOk ? '' : '; warning: short redirect may still be running'})`);
      return 0;
    }
    await sleep(200);
  }

  killSession(session);
  const killDeadline = Date.now() + 5000;
  while (Date.now() < killDeadline) {
    if (!hasSession(session)) {
      const shortOk = await stopShort(state);
      removeState();
      console.log(`stopped (${session}, killed${shortOk ? '' : '; warning: short redirect may still be running'})`);
      return 0;
    }
    await sleep(200);
  }

  fail(`could not stop tmux session "${session}"`);
}

async function status(cfg) {
  const state = readState();
  const session = state?.session || cfg.session;
  const exists = hasSession(session);
  const shortHost = shortBindHost(cfg);
  const shortUrl = state?.shortUrl || shortUrlOf(cfg);
  const shortAlive = Boolean(state?.shortPid && isOurRedirect(state.shortPid) && (!state.bootId || state.bootId === currentBootId()));
  const shortOpen = await isPortOpen(shortHost, cfg.shortPort);

  console.log(`session: ${session}`);
  console.log(`config:  ${CONFIG_PATH}`);
  console.log(`state:   ${state ? STATE_PATH : 'missing'}`);
  console.log(`log:     ${LOG_PATH}`);
  console.log(`short:   ${shortUrl} ${shortAlive && shortOpen ? 'open' : 'closed'}${state?.shortPid ? ` (pid ${state.shortPid})` : ''}`);

  if (state?.bootId && state.bootId !== currentBootId()) {
    console.log('warning: state is from a previous boot; it will be treated as stale');
  }
  if (!state && !exists) {
    console.log('status:  not running');
    return 0;
  }
  if (!exists) {
    console.log(`status:  stale state; the tmux session is not running${shortAlive ? ' (short redirect is still running; run stop)' : ''}`);
    return 0;
  }

  const pane = sessionPaneInfo(session);
  const host = state?.host || cfg.host;
  const port = state?.port || cfg.port;
  const open = await isPortOpen(host, port);

  if (pane) {
    console.log(`pane:    ${pane.id ?? '?'} (pid ${pane.pid ?? '?'}${pane.dead ? ', dead' : ''})`);
  }
  if (state?.url) console.log(`url:     ${state.url}`);
  console.log(`tcp:     ${host}:${port} ${open ? 'open' : 'closed'}`);

  if (state?.panePid && pane?.pid && state.panePid !== pane.pid) {
    console.log(`warning: pane pid changed from ${state.panePid} to ${pane.pid}`);
  }
  if (!state) {
    console.log('status:  unmanaged tmux session (no state file)');
  } else if (!pane || pane.dead || !open) {
    console.log('status:  session exists, but the server is not listening; check logs');
  } else if (!shortAlive || !shortOpen) {
    console.log('status:  running (short redirect is not running; run start to recreate it)');
  } else {
    console.log('status:  running');
  }
  return 0;
}

async function logs(cfg, args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const numeric = args.find((arg) => /^\d+$/.test(arg));
  const lines = numeric ? Number(numeric) : cfg.logTailLines;

  if (!fs.existsSync(LOG_PATH)) {
    console.log(`no log yet: ${LOG_PATH}`);
    return 0;
  }

  if (follow) {
    return await new Promise((resolve) => {
      const child = spawn('tail', ['-n', String(lines), '-f', LOG_PATH], { stdio: 'inherit' });
      child.once('error', (error) => {
        console.error(`tail: ${error.message}`);
        resolve(1);
      });
      child.once('exit', (code) => resolve(code ?? 0));
    });
  }

  const result = spawnSync('tail', ['-n', String(lines), LOG_PATH], { encoding: 'utf8' });
  if (result.error) fail(`tail: ${result.error.message}`);
  if (result.status !== 0) fail(`tail failed: ${(result.stderr || '').trim()}`);
  process.stdout.write(result.stdout);
  return 0;
}

function attach(cfg) {
  const state = readState();
  const session = state?.session || cfg.session;
  if (!hasSession(session)) fail(`no tmux session "${session}"; start it first`);
  const result = spawnSync('tmux', ['attach-session', '-t', session], { stdio: 'inherit' });
  if (result.error) fail(`tmux attach: ${result.error.message}`);
  if (result.status !== 0) fail(`tmux attach exited with ${result.status}`);
  return 0;
}

function showUrl() {
  const state = readState();
  if (!state?.url) fail('no running instance with a recorded URL; start it first');
  console.log(state.url);
  return 0;
}

function showShort(cfg) {
  console.log(shortUrlOf(cfg));
  return 0;
}

async function redirect(cfg) {
  const host = shortBindHost(cfg);
  const port = cfg.shortPort;
  const server = http.createServer((req, res) => {
    let state = null;
    try {
      state = readState();
    } catch {}
    if (!state?.url) {
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('DSH is not ready yet; retry in a few seconds.\n');
      return;
    }
    res.writeHead(302, {
      Location: state.url,
      'Cache-Control': 'no-store',
    });
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`short: http://${host}:${port}/`);
      resolve();
    });
  });
  return 0;
}

function help() {
  const name = path.basename(process.argv[1]);
  console.log(`dsh-web — run the DSH Web UI in a detached tmux session

Usage:
  node ${name} start
  node ${name} stop
  node ${name} restart
  node ${name} status
  node ${name} url
  node ${name} short
  node ${name} logs [-f] [lines]
  node ${name} attach

Files:
  config  ${CONFIG_PATH}
  state   ${STATE_PATH}
  log     ${LOG_PATH}

The short URL is token-free and 302s to the current token URL. This script
writes its runtime files next to itself; DSH itself still keeps its profile and
session data in ~/.dsh.`);
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'help' || command === '-h' || command === '--help') {
    help();
    return 0;
  }

  const cfg = loadConfig();
  switch (command) {
    case 'start':
      return await start(cfg);
    case 'stop':
      return await stop(cfg);
    case 'restart':
      await stop(cfg);
      return await start(cfg);
    case 'status':
      return await status(cfg);
    case 'url':
      return showUrl();
    case 'short':
      return showShort(cfg);
    case 'redirect':
      return await redirect(cfg);
    case 'logs':
      return await logs(cfg, process.argv.slice(3));
    case 'attach':
      return attach(cfg);
    default:
      help();
      fail(`unknown command: ${command}`);
  }
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
