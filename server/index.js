const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const pty = require('node-pty');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// NOTE: auth removed per user request — this accepts all connections.
// Make sure the service is private or behind an access layer if you keep this.
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.get('/health', (req, res) => res.json({ ok: true }));

wss.on('connection', function connection(ws, req) {
  // No authentication: accept every connection
  startPtyForConnection(ws);
});

function startPtyForConnection(ws) {
  const cols = 80;
  const rows = 24;
  const env = Object.assign({}, process.env);
  const term = pty.spawn(SHELL, [], {
    name: 'xterm-color',
    cols: cols,
    rows: rows,
    cwd: process.cwd(),
    env: env
  });

  term.on('data', function(data) {
    try { ws.send(JSON.stringify({ type: 'output', data })); } catch (e) {}
  });

  ws.on('message', function incoming(message) {
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
  });

  ws.on('close', function() {
    try { term.kill(); } catch (e) {}
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
