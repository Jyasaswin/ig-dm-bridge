import * as vscode from 'vscode';

export class IgDmPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _context: vscode.ExtensionContext;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext
  ) {
    this._context = context;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'save_credentials':
          try {
            await this._context.secrets.store('ig_username', message.username);
            await this._context.secrets.store('ig_password', message.password);
            await this._context.secrets.store('server_port', message.port || '3421');
            
            webviewView.webview.postMessage({
              type: 'credentials_saved',
              msg: 'Credentials stored securely.',
              username: message.username,
              port: message.port || '3421'
            });
          } catch (error) {
            webviewView.webview.postMessage({
              type: 'error',
              msg: 'Failed to save credentials'
            });
          }
          break;

        case 'get_credentials':
          const username = await this._context.secrets.get('ig_username') || '';
          const password = await this._context.secrets.get('ig_password') || '';
          const port = await this._context.secrets.get('server_port') || '3421';
          webviewView.webview.postMessage({
            type: 'credentials_loaded',
            username,
            password,
            port,
          });
          break;

        case 'clear_credentials':
          await this._context.secrets.delete('ig_username');
          await this._context.secrets.delete('ig_password');
          await this._context.secrets.delete('ig_target');
          webviewView.webview.postMessage({ type: 'credentials_cleared' });
          break;

        case 'show_error':
          vscode.window.showErrorMessage(message.message);
          break;

        case 'show_info':
          vscode.window.showInformationMessage(message.message);
          break;
      }
    });
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IG DM Terminal</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --border: #21262d;
    --green: #39ff14;
    --green-dim: #1a7a08;
    --cyan: #79c0ff;
    --yellow: #e3b341;
    --red: #f85149;
    --gray: #8b949e;
    --white: #c9d1d9;
    --font: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  }

  body {
    background: var(--bg);
    color: var(--green);
    font-family: var(--font);
    font-size: 11px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* TOP BAR */
  .topbar {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 5px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .topbar-title { color: var(--gray); font-size: 10px; letter-spacing: 1px; }
  .status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--red); display: inline-block; margin-right: 5px;
  }
  .status-dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .status-dot.syncing { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .status-label { font-size: 10px; color: var(--gray); }
  .btn-small {
    background: none; border: 1px solid var(--border);
    color: var(--gray); font-family: var(--font); font-size: 10px;
    padding: 2px 6px; cursor: pointer; border-radius: 2px;
  }
  .btn-small:hover { border-color: var(--green); color: var(--green); }

  /* SCREENS */
  .screen { display: none; flex-direction: column; flex: 1; overflow: hidden; }
  .screen.active { display: flex; }

  /* STAGE 1: LOGIN SCREEN */
  #login-screen {
    padding: 12px;
    gap: 6px;
    overflow-y: auto;
  }
  .setup-line { color: var(--green); margin-bottom: 4px; font-size: 11px; }
  .setup-line .prompt { color: var(--gray); }
  .setup-label { color: var(--cyan); font-size: 10px; margin-top: 8px; margin-bottom: 2px; }
  .setup-input {
    width: 100%;
    background: var(--bg2);
    border: 1px solid var(--border);
    color: var(--green);
    font-family: var(--font);
    font-size: 11px;
    padding: 6px 8px;
    outline: none;
    border-radius: 2px;
  }
  .setup-input:focus { border-color: var(--green); }
  .btn-connect {
    margin-top: 12px;
    width: 100%;
    background: none;
    border: 1px solid var(--green);
    color: var(--green);
    font-family: var(--font);
    font-size: 11px;
    padding: 7px;
    cursor: pointer;
    letter-spacing: 1px;
    transition: all 0.2s;
  }
  .btn-connect:hover { background: var(--green); color: var(--bg); }
  #login-status {
    margin-top: 10px;
    padding: 6px 8px;
    border: 1px dashed var(--border);
    font-size: 10px;
    display: none;
    word-break: break-word;
    border-radius: 2px;
  }

  /* STAGE 2: SYNC SCREEN */
  #sync-screen {
    padding: 20px 12px;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 12px;
  }
  .spinner {
    width: 24px; height: 24px;
    border: 2px solid var(--border);
    border-top: 2px solid var(--green);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

  /* STAGE 3: CHAT SCREEN */
  #chat-screen { }
  .target-bar {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 6px 8px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }
  .target-select {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--cyan);
    font-family: var(--font);
    font-size: 11px;
    padding: 4px 6px;
    outline: none;
    border-radius: 2px;
  }
  .target-select:focus { border-color: var(--cyan); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .msg {
    display: flex;
    gap: 6px;
    line-height: 1.4;
    font-size: 11px;
    word-break: break-word;
  }
  .msg .ts { color: var(--gray); flex-shrink: 0; font-size: 9px; }
  .msg .who { flex-shrink: 0; }
  .msg.me .who { color: var(--green); }
  .msg.them .who { color: var(--cyan); }
  .msg.sys .who { color: var(--yellow); }
  .msg.err .who { color: var(--red); }
  .msg .text { color: var(--white); }
  .msg.sys .text { color: var(--yellow); }
  .msg.err .text { color: var(--red); }

  .input-bar {
    border-top: 1px solid var(--border);
    background: var(--bg2);
    display: flex;
    align-items: center;
    padding: 6px 8px;
    gap: 6px;
    flex-shrink: 0;
  }
  .input-prompt { color: var(--green); flex-shrink: 0; font-size: 12px; }
  #msg-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--green);
    font-family: var(--font);
    font-size: 11px;
    caret-color: var(--green);
  }
  .poll-bar {
    background: var(--bg);
    border-top: 1px solid var(--border);
    padding: 3px 8px;
    color: var(--gray);
    font-size: 9px;
    display: flex;
    justify-content: space-between;
    flex-shrink: 0;
  }
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <span class="topbar-title">▸ IG DM TERMINAL</span>
  <div style="display:flex;align-items:center;gap:6px;">
    <span class="status-dot" id="dot"></span>
    <span class="status-label" id="status-label">offline</span>
    <button class="btn-small" id="btn-settings" title="Account Settings / Change Login">⚙</button>
  </div>
</div>

<!-- STAGE 1: LOGIN SCREEN -->
<div class="screen active" id="login-screen">
  <div class="setup-line"><span class="prompt">$</span> igdm --login</div>
  <div class="setup-line" style="color:var(--gray);font-size:10px;">Enter your Instagram credentials. Credentials are stored securely in VS Code SecretStorage.</div>

  <div class="setup-label">// instagram username</div>
  <input class="setup-input" id="cfg-user" type="text" placeholder="username" autocomplete="off" spellcheck="false">

  <div class="setup-label">// instagram password</div>
  <input class="setup-input" id="cfg-pass" type="password" placeholder="••••••••" autocomplete="off">

  <div class="setup-label">// local server port (default 3421)</div>
  <input class="setup-input" id="cfg-port" type="text" placeholder="3421" value="3421" autocomplete="off">

  <button class="btn-connect" id="btn-login">▸ LOGIN &amp; START SESSION</button>

  <div id="login-status"></div>

  <div style="margin-top:12px;color:var(--gray);font-size:9px;line-height:1.4;">
    <span>⚠</span> Make sure local server is running:<br>
    <code style="color:var(--green);">node server/index.js</code>
  </div>
</div>

<!-- STAGE 2: SYNC SCREEN -->
<div class="screen" id="sync-screen">
  <div class="spinner"></div>
  <div style="color:var(--cyan);font-size:11px;">Syncing Instagram Chats &amp; Following...</div>
  <div style="color:var(--gray);font-size:9px;">Gathering your threads and storing them into local JSON cache</div>
</div>

<!-- STAGE 3: CHAT SCREEN -->
<div class="screen" id="chat-screen">
  <div class="target-bar">
    <span style="color:var(--gray);font-size:10px;">target:</span>
    <select class="target-select" id="target-select">
      <option value="">-- Select or Search Target User --</option>
    </select>
    <button class="btn-small" id="btn-resync" title="Resync Threads">↺</button>
  </div>

  <div id="messages"></div>

  <div class="input-bar">
    <span class="input-prompt">❯</span>
    <input id="msg-input" type="text" placeholder="type message… (Enter to send)" autocomplete="off" spellcheck="false">
  </div>

  <div class="poll-bar">
    <span id="last-check">last check: —</span>
    <span id="msg-count">0 messages</span>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  let serverPort = '3421';
  let myUser = '';
  let myPassword = '';
  let activeTarget = '';
  let pollTimer = null;
  let messageCache = [];
  let cachedThreads = [];

  // Listeners
  document.getElementById('btn-login').addEventListener('click', handleLoginSubmit);
  document.getElementById('btn-settings').addEventListener('click', showLoginScreen);
  document.getElementById('btn-resync').addEventListener('click', startStage2Sync);
  document.getElementById('target-select').addEventListener('change', handleTargetChange);

  document.querySelectorAll('.setup-input').forEach(input => {
    input.addEventListener('input', () => showLoginStatus(''));
  });

  // Message Handler from Extension Host
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'credentials_loaded') {
      if (msg.username) document.getElementById('cfg-user').value = msg.username;
      if (msg.password) document.getElementById('cfg-pass').value = msg.password;
      if (msg.port) document.getElementById('cfg-port').value = msg.port;
      
      myUser = msg.username || '';
      myPassword = msg.password || '';
      serverPort = msg.port || '3421';

      if (myUser && myPassword) {
        // Auto-run Stage 1 login & proceed to Stage 2/3
        startStage1Login();
      }
    }
  });

  // Load creds on startup
  vscode.postMessage({ type: 'get_credentials' });

  function setStatusDot(state) {
    const dot = document.getElementById('dot');
    const label = document.getElementById('status-label');
    dot.className = 'status-dot ' + state;
    label.textContent = state === 'online' ? 'online' : (state === 'syncing' ? 'syncing' : 'offline');
  }

  function showLoginStatus(msg, isError = false) {
    const el = document.getElementById('login-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.style.color = isError ? 'var(--red)' : 'var(--green)';
    el.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
    el.textContent = msg ? (isError ? '✗ ' + msg : '✓ ' + msg) : '';
  }

  function showLoginScreen() {
    stopPolling();
    setStatusDot('');
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('sync-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.remove('active');
  }

  function showSyncScreen() {
    stopPolling();
    setStatusDot('syncing');
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('sync-screen').classList.add('active');
    document.getElementById('chat-screen').classList.remove('active');
  }

  function showChatScreen() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('sync-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    document.getElementById('msg-input').focus();
  }

  // STAGE 1: LOGIN SUBMIT
  async function handleLoginSubmit() {
    const u = document.getElementById('cfg-user').value.trim();
    const p = document.getElementById('cfg-pass').value;
    const port = document.getElementById('cfg-port').value.trim() || '3421';

    if (!u || !p) {
      showLoginStatus('Please enter username and password.', true);
      return;
    }

    myUser = u;
    myPassword = p;
    serverPort = port;

    vscode.postMessage({ type: 'save_credentials', username: u, password: p, port });
    await startStage1Login();
  }

  async function startStage1Login() {
    showLoginStatus('Connecting to server...');
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: myUser, password: myPassword })
      });

      if (res.ok) {
        showLoginStatus('');
        startStage2Sync();
      } else {
        const d = await res.json();
        const errText = 'Login failed: ' + (d.error || 'Check server');
        showLoginStatus(errText, true);
        vscode.postMessage({ type: 'show_error', message: errText });
      }
    } catch (err) {
      const errText = 'Cannot reach server on 127.0.0.1:' + serverPort + '. Make sure node server/index.js is running.';
      showLoginStatus(errText, true);
      vscode.postMessage({ type: 'show_error', message: errText });
    }
  }

  // STAGE 2: SYNC THREADS
  async function startStage2Sync() {
    showSyncScreen();
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/sync-threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();

      if (data.threads) {
        cachedThreads = data.threads;
        populateTargetSelect(data.threads);
      }
      
      showChatScreen();
      sysMsg('Chats synced successfully (' + cachedThreads.length + ' contacts loaded). Select a target user above.');
    } catch (err) {
      showChatScreen();
      errMsg('Sync failed: ' + err.message);
    }
  }

  function populateTargetSelect(threads) {
    const select = document.getElementById('target-select');
    select.innerHTML = '<option value="">-- Select Target User --</option>';

    threads.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.username;
      opt.setAttribute('data-thread-id', t.threadId);
      opt.textContent = '@' + t.username + (t.displayName && t.displayName !== t.username ? ' (' + t.displayName + ')' : '');
      select.appendChild(opt);
    });

    if (activeTarget) select.value = activeTarget;
  }

  // STAGE 3: SELECT TARGET & CHAT
  async function handleTargetChange(e) {
    const username = e.target.value;
    if (!username) return;

    const opt = e.target.options[e.target.selectedIndex];
    const threadId = opt ? opt.getAttribute('data-thread-id') : null;

    activeTarget = username;
    sysMsg('Selecting target @' + activeTarget + '...');

    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/select-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUser: activeTarget, threadId })
      });

      if (res.ok) {
        setStatusDot('online');
        sysMsg('Opened thread with @' + activeTarget);
        fetchMessages();
        startPolling();
      } else {
        const d = await res.json();
        errMsg('Failed to open thread: ' + (d.error || res.status));
      }
    } catch (err) {
      errMsg('Connection error selecting target: ' + err.message);
    }
  }

  // POLLING & MESSAGING
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(fetchMessages, 4000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function fetchMessages() {
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/messages');
      const data = await res.json();
      if (data.messages) {
        renderMessages(data.messages);
        document.getElementById('last-check').textContent = 'last check: ' + new Date().toLocaleTimeString();
        document.getElementById('msg-count').textContent = data.messages.length + ' msgs';
        setStatusDot('online');
      }
    } catch (e) {
      setStatusDot('');
    }
  }

  function renderMessages(msgs) {
    const container = document.getElementById('messages');
    if (JSON.stringify(msgs) === JSON.stringify(messageCache)) return;
    messageCache = msgs;

    const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 20;
    container.innerHTML = '';

    msgs.forEach((m) => {
      const isMe = m.user_id === 'me' || m.username === myUser;
      const div = document.createElement('div');
      div.className = 'msg ' + (isMe ? 'me' : 'them');
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
      div.innerHTML =
        '<span class="ts">' + ts + '</span>' +
        '<span class="who">' + (isMe ? myUser : activeTarget) + '</span>' +
        '<span class="text">' + escHtml(m.text) + '</span>';
      container.appendChild(div);
    });

    if (wasAtBottom) container.scrollTop = container.scrollHeight;
  }

  document.getElementById('msg-input').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const text = e.target.value.trim();
      if (!text) return;
      e.target.value = '';
      await sendMessage(text);
    }
  });

  async function sendMessage(text) {
    addLocalMsg(myUser, text, 'me');
    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (res.ok) {
        setTimeout(fetchMessages, 1000);
      } else {
        const d = await res.json();
        errMsg('Send failed: ' + (d.error || res.status));
      }
    } catch (err) {
      errMsg('Send error: ' + err.message);
    }
  }

  function addLocalMsg(user, text, cls) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    div.innerHTML =
      '<span class="ts">' + ts + '</span>' +
      '<span class="who">' + user + '</span>' +
      '<span class="text">' + escHtml(text) + '</span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function sysMsg(text) {
    const container = document.getElementById('messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'msg sys';
    const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    div.innerHTML =
      '<span class="ts">' + ts + '</span>' +
      '<span class="who">system</span>' +
      '<span class="text">' + escHtml(text) + '</span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function errMsg(text) {
    const container = document.getElementById('messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'msg err';
    const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    div.innerHTML =
      '<span class="ts">' + ts + '</span>' +
      '<span class="who">error</span>' +
      '<span class="text">' + escHtml(text) + '</span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
  }
}