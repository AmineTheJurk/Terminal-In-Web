const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const pty = require('node-pty');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// No global ADMIN_TOKEN — auth removed per user request. We create per-connection workspaces.
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

const WORKSPACES_BASE = path.join(os.tmpdir(), 'terminal-workspaces');
try { fs.mkdirSync(WORKSPACES_BASE, { recursive: true }); } catch (e) { /* ignore */ }

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.get('/health', (req, res) => res.json({ ok: true }));

wss.on('connection', function connection(ws, req) {
  // Ask the client for a username. The client should reply with JSON { type: 'username', username: '...' }
  ws.send(JSON.stringify({ type: 'request-username', prompt: 'Enter username:' }));

  // Wait for the username message once, then create a workspace and spawn the shell
  const usernameListener = (message) => {
    let parsed = null;
    try { parsed = JSON.parse(message); } catch (e) { /* not JSON */ }

    let usernameRaw = '';
    if (parsed && parsed.type === 'username' && parsed.username) {
      usernameRaw = String(parsed.username);
    } else {
      usernameRaw = String(message).trim();
    }

    // sanitize username: allow letters, numbers, dash, underscore; fallback to guest
    let username = usernameRaw.replace(/[^A-Za-z0-9_-]/g, '') || 'guest';

    // create a unique workspace directory for this connection
    const id = crypto.randomBytes(4).toString('hex');
    const workspaceDir = path.join(WORKSPACES_BASE, `${username}-${id}`);
    try {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'failed to create workspace' }));
      ws.close();
      return;
    }

    // acknowledge and proceed
    ws.send(JSON.stringify({ type: 'info', message: `Workspace created: ~/${username}-${id}` }));

    // remove this listener and start the pty session rooted at the workspace
    ws.removeListener('message', usernameListener);
    startPtyForConnection(ws, workspaceDir, username);
  };

  ws.on('message', usernameListener);
});

function startPtyForConnection(ws, cwd, username) {
  // spawn a shell for each connection with cwd set to the workspace
  const cols = 80;
  const rows = 24;
  const env = Object.assign({}, process.env, {
    HOME: cwd,
    USER: username,
    LOGNAME: username,
    // set a simple prompt; terminals may honor PS1
    PS1: `${username}@${os.hostname()}:~$ `
  });

  const term = pty.spawn(SHELL, ['-i'], {
    name: 'xterm-color',
    cols: cols,
    rows: rows,
    cwd: cwd,
    env: env
  });

  // Send a small greeting to the terminal
  term.write(`cd ${cwd}\r\n`);
  term.write(`echo "Welcome ${username}! Your workspace is set to ~"\r\n`);

  term.on('data', function(data) {
    try { ws.send(JSON.stringify({ type: 'output', data })); } catch (e) {}
  });

  const onMessage = (message) => {
    // messages are either control JSON or raw input
    let parsed = null;
    try { parsed = JSON.parse(message); } catch (e) { /* not JSON — treat as raw */ }

    if (parsed && parsed.type === 'resize') {
      const cols = parseInt(parsed.cols, 10) || 80;
      const rows = parseInt(parsed.rows, 10) || 24;
      term.resize(cols, rows);
      return;
    }

    if (parsed && parsed.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // otherwise treat as raw input string
    if (!parsed) {
      term.write(message);
    }
  };

  ws.on('message', onMessage);

  ws.on('close', function() {
    try { term.kill(); } catch (e) {}
    // optionally: remove the workspace directory when session ends
    // fs.rmSync(cwd, { recursive: true, force: true });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
