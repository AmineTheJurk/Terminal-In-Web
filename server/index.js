const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const pty = require('node-pty');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

// simple in-memory session store: sid -> { expires }
const SESSIONS = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Login endpoint: accepts token via form POST and sets an HttpOnly session cookie
app.post('/login', (req, res) => {
  const token = (req.body && req.body.token) ? String(req.body.token) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).send('invalid');
  }

  const sid = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  SESSIONS.set(sid, { expires });

  const secureCookie = req.secure || (req.headers['x-forwarded-proto'] === 'https') || (process.env.NODE_ENV === 'production');
  res.cookie('sid', sid, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS
  });

  return res.send('ok');
});

app.get('/logout', (req, res) => {
  const sid = req.cookies && req.cookies.sid;
  if (sid) SESSIONS.delete(sid);
  res.clearCookie('sid');
  res.send('ok');
});

// Simple session check used by the client to know whether to show login or terminal
app.get('/session', (req, res) => {
  const sid = req.cookies && req.cookies.sid;
  if (!sid) return res.status(401).send('no');
  const sess = SESSIONS.get(sid);
  if (!sess) return res.status(401).send('no');
  if (sess.expires < Date.now()) {
    SESSIONS.delete(sid);
    res.clearCookie('sid');
    return res.status(401).send('expired');
  }
  // refresh expiry
  sess.expires = Date.now() + SESSION_TTL_MS;
  SESSIONS.set(sid, sess);
  return res.json({ ok: true });
});

function parseCookies(header) {
  const obj = {};
  if (!header) return obj;
  header.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    const val = parts.join('=').trim();
    try { obj[key] = decodeURIComponent(val); } catch (e) { obj[key] = val; }
  });
  return obj;
}

wss.on('connection', function connection(ws, req) {
  // Attempt token auth via query param first (backwards compatible)
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const token = params.get('token') || '';
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
    return startPtyForConnection(ws);
  }

  // Otherwise try session cookie
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies.sid;
  if (!sid) {
    ws.send(JSON.stringify({ type: 'error', message: 'invalid token or session' }));
    ws.close();
    return;
  }

  const sess = SESSIONS.get(sid);
  if (!sess || sess.expires < Date.now()) {
    if (sess) SESSIONS.delete(sid);
    ws.send(JSON.stringify({ type: 'error', message: 'invalid token or session' }));
    ws.close();
    return;
  }

  // refresh expiry
  sess.expires = Date.now() + SESSION_TTL_MS;
  SESSIONS.set(sid, sess);

  startPtyForConnection(ws);
});

function startPtyForConnection(ws) {
  // spawn a shell for each connection
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
