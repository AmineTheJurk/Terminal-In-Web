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

// Map workspace id -> full path
const WORKSPACES = new Map();

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Download endpoint for files inside a workspace
app.get('/workspaces/:id/download', (req, res) => {
  const id = req.params.id;
  const workspace = WORKSPACES.get(id);
  if (!workspace) return res.status(404).send('workspace not found');

  const rel = req.query.file || req.query.path || '';
  // normalize and prevent path traversal
  const decoded = path.normalize(rel).replace(/^([\.\/\\])+/, '');
  const full = path.join(workspace, decoded);
  if (!full.startsWith(workspace)) return res.status(400).send('invalid path');
  if (!fs.existsSync(full)) return res.status(404).send('file not found');

  const asName = req.query.as || path.basename(full);
  res.download(full, asName);
});

const USERNAME_TIMEOUT_MS = 30_000; // 30 seconds to send a valid username JSON

wss.on('connection', function connection(ws, req) {
  // Ask the client for a username. The client should reply with JSON { type: 'username', username: '...' }
  ws.send(JSON.stringify({ type: 'request-username', prompt: 'Enter username:' }));

  // Helper to ignore non-JSON or irrelevant messages while waiting for the explicit username
  function safeParseJson(msg) {
    try { return JSON.parse(msg); } catch (e) { return null; }
  }

  // Set a timeout to close idle connections that never send a proper username JSON
  const usernameTimer = setTimeout(() => {
    console.log('Closing connection: no valid username received in time.');
    try { ws.send(JSON.stringify({ type: 'error', message: 'no username provided' })); } catch (e) {}
    try { ws.close(); } catch (e) {}
  }, USERNAME_TIMEOUT_MS);

  // Wait for the username message once, then create a workspace and spawn the shell
  const usernameListener = (message) => {
    const parsed = safeParseJson(message);

    // only accept explicit JSON { type: 'username', username: '...' }
    if (!parsed || parsed.type !== 'username' || !parsed.username) {
      // ignore anything else (no workspace creation)
      // log for diagnostics (do not log full message to avoid PII)
      console.log('Ignored non-username message while awaiting username.');
      return;
    }

    // got a valid username object; clear the timeout
    clearTimeout(usernameTimer);

    const usernameRaw = String(parsed.username);
    // sanitize username: allow letters, numbers, dash, underscore; fallback to guest
    const username = usernameRaw.replace(/[^A-Za-z0-9_-]/g, '') || 'guest';

    // create a unique workspace directory for this connection
    const id = crypto.randomBytes(6).toString('hex');
    const workspaceDir = path.join(WORKSPACES_BASE, `${username}-${id}`);
    try {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'failed to create workspace' }));
      ws.close();
      return;
    }

    // create Downloads dir and a helper script `downloadfile`
    try {
      fs.mkdirSync(path.join(workspaceDir, 'Downloads'), { recursive: true, mode: 0o700 });

      const script = `#!/bin/sh\n# downloadfile: server-assisted download helper\n# usage: downloadfile <file> [-o output]\nOUT=\"\"\nFILE=\"\"\nif [ \"$1\" = \"\" ]; then echo \"usage: downloadfile <file> [-o output]\"; exit 1; fi\nFILE=\"$1\"\nshift\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in\n    -o) shift; OUT=\"$1\"; shift; ;\n    *) shift; ;\n  esac\ndone\nif [ ! -f \"$FILE\" ]; then echo \"file not found: $FILE\"; exit 2; fi\nif [ -z \"$OUT\" ]; then OUT=\"$(basename \"$FILE\")\"; fi\n# copy to workspace Downloads for convenience\nmkdir -p \"$HOME/Downloads\"\ncp -- \"$FILE\" \"$HOME/Downloads/$OUT\"\n# print special marker for the browser client to trigger download: __DOWNLOAD__:<relpath>:<outname>\nREL=$(realpath --relative-to \"$HOME\" \"$FILE\" 2>/dev/null)\n# if realpath not available or fails, fallback to basename\nif [ -z \"$REL\" ]; then REL=$(basename \"$FILE\"); fi\necho \"__DOWNLOAD__:$REL:$OUT\"\n`;
      fs.writeFileSync(path.join(workspaceDir, 'downloadfile'), script, { mode: 0o755 });
    } catch (e) {
      // ignore script creation errors
    }

    // register workspace id -> path
    WORKSPACES.set(id, workspaceDir);

    // acknowledge and proceed (send workspace id back explicitly)
    ws.send(JSON.stringify({ type: 'ready', id: id, name: `${username}-${id}`, message: `Workspace created: ~/${username}-${id}` }));

    // remove this listener and start the pty session rooted at the workspace
    ws.removeListener('message', usernameListener);
    startPtyForConnection(ws, workspaceDir, username, id);
  };

  ws.on('message', usernameListener);

  // Ensure the usernameTimer is cleared if the socket closes before a username is provided
  ws.on('close', () => {
    clearTimeout(usernameTimer);
  });
});

function startPtyForConnection(ws, cwd, username, workspaceId) {
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
    // remove the workspace mapping; keep files by default but remove mapping
    try { WORKSPACES.delete(workspaceId); } catch (e) {}
    // optional: remove the workspace directory when session ends
    // fs.rmSync(cwd, { recursive: true, force: true });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
