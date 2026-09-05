#!/usr/bin/env node

const { IgApiClient } = require('instagram-private-api');
const chalk = require('chalk');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Configuration files
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SESSION_FILE = path.join(__dirname, '.ig-session.json');

class InstagramTerminalClient {
  constructor() {
    this.ig = new IgApiClient();
    this.targetUser = null;
    this.targetId = null;
    this.username = null;
    this.threadId = null;
    this.pollInterval = null;
    this.lastMessageId = null;
    this.isLoggedIn = false;
    this.config = null;
    
    // Setup readline for input
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    // Handle exit
    process.on('SIGINT', () => {
      this.cleanup();
      process.exit(0);
    });
  }

  // Load config from file
  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
        this.config = JSON.parse(configData);
        console.log(chalk.green('  ✓ config loaded from config.json'));
        return true;
      }
      console.log(chalk.yellow('  ! config.json not found, using interactive mode'));
      return false;
    } catch (err) {
      console.log(chalk.red(`  ! config error: ${err.message}`));
      return false;
    }
  }

  // Load session
  async loadSession() {
    if (fs.existsSync(SESSION_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        this.username = data.username;
        this.targetUser = data.target;
        console.log(chalk.dim(`  session loaded for @${this.username}`));
        return true;
      } catch (e) {
        console.log(chalk.dim('  session corrupt, ignoring'));
      }
    }
    return false;
  }

  // Save session
  async saveSession(username, target) {
    const data = { username, target, timestamp: new Date().toISOString() };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    console.log(chalk.dim('  session saved'));
  }

  saveThreadId(threadId) {
    try {
      let data = {};
      if (fs.existsSync(SESSION_FILE)) {
        data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      }
      data.threadId = threadId;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      // Silently ignore
    }
  }

  // Load thread ID from session
  loadThreadId() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        return data.threadId || null;
      }
    } catch (e) {}
    return null;
  }

  // Simple password input with hidden characters
  askPassword(question) {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      
      stdout.write(question);
      
      let password = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      
      const onData = (char) => {
        char = char.toString();
        
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(password);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007f' || char === '\b') {
          if (password.length > 0) {
            password = password.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (char.length === 1 && char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          password += char;
          stdout.write('*');
        }
      };
      
      stdin.on('data', onData);
    });
  }

  askQuestion(question) {
    return new Promise((resolve) => {
      this.rl.question(question, resolve);
    });
  }

  async getCredentials() {
    // Try config file first
    if (this.loadConfig()) {
      this.username = this.config.username;
      this.targetUser = this.config.target;
      return {
        username: this.config.username,
        password: this.config.password,
        target: this.config.target
      };
    }

    // Try session file
    if (await this.loadSession()) {
      console.log(chalk.dim(`  using saved session for @${this.username}`));
      const password = await this.askPassword(chalk.dim('  password: '));
      const target = await this.askQuestion(chalk.dim(`  target (@${this.targetUser}): `));
      return {
        username: this.username,
        password: password,
        target: target || this.targetUser
      };
    }

    // Interactive mode
    console.log(chalk.dim('\n  enter credentials:'));
    const username = await this.askQuestion(chalk.dim('  username: '));
    const password = await this.askPassword(chalk.dim('  password: '));
    const target = await this.askQuestion(chalk.dim('  target username: '));
    
    return { username, password, target };
  }

  async login() {
    console.clear();
    console.log(chalk.bold.cyan('\n  ═══ instagram dm terminal ═══\n'));
    
    const creds = await this.getCredentials();

    if (!creds.username || !creds.password || !creds.target) {
      console.log(chalk.red('\n  [!] all fields required\n'));
      process.exit(1);
    }

    this.username = creds.username;
    this.targetUser = creds.target;

    console.log(chalk.dim(`\n  logging in as @${creds.username}...`));
    
    try {
      // Generate device
      this.ig.state.generateDevice(creds.username);
      
      // Login
      const loggedInUser = await this.ig.account.login(creds.username, creds.password);
      this.isLoggedIn = true;
      
      console.log(chalk.green(`  ✓ connected as ${loggedInUser.username}`));
      console.log(chalk.dim(`  ✓ user id: ${loggedInUser.pk}`));
      
      // Save session
      await this.saveSession(creds.username, creds.target);
      
      // Get target user ID
      console.log(chalk.dim(`\n  finding @${creds.target}...`));
      try {
        const user = await this.ig.user.getIdByUsername(creds.target);
        this.targetId = user;
        console.log(chalk.green(`  ✓ found user: ${creds.target}`));
        console.log(chalk.dim(`  ✓ user id: ${user}`));
      } catch (e) {
        console.log(chalk.red(`  [!] user ${creds.target} not found`));
        console.log(chalk.dim(`  error: ${e.message}`));
        process.exit(1);
      }
      
      // Get or create thread
      await this.getOrCreateThread();
      
      // Start message polling
      this.startPolling();
      
      // Start input handler
      this.handleInput();
      
    } catch (err) {
      console.log(chalk.red(`\n  [!] login failed: ${err.message}`));
      console.log(chalk.dim('\n  tips:'));
      console.log(chalk.dim('  - check username and password'));
      console.log(chalk.dim('  - try logging in from browser first'));
      console.log(chalk.dim('  - delete .ig-session.json and try again'));
      console.log(chalk.dim('  - check config.json if using config file\n'));
      process.exit(1);
    }
  }

  async getOrCreateThread() {
    try {
      console.log(chalk.dim('\n  finding conversation...'));
      
      // Try to load saved thread ID
      const savedThreadId = this.loadThreadId();
      if (savedThreadId) {
        try {
          // Verify thread still exists
          await this.ig.direct.thread.get(savedThreadId);
          this.threadId = savedThreadId;
          console.log(chalk.green(`  ✓ using saved thread: ${this.threadId}`));
          return;
        } catch (e) {
          console.log(chalk.dim('  saved thread expired, finding new...'));
        }
      }
      
      // Get inbox threads
      const threads = await this.ig.feed.directInbox().items();
      
      // Find thread with target
      let thread = threads.find(t => {
        const users = t.users || [];
        return users.some(u => u.pk === this.targetId);
      });
      
      if (thread) {
        this.threadId = thread.thread_id;
        console.log(chalk.green(`  ✓ found conversation: ${this.threadId}`));
      } else {
        console.log(chalk.dim('  no existing conversation, creating new...'));
        // Create new thread
        const threadData = await this.ig.direct.thread.broadcast({
          recipientUsers: [this.targetId],
          text: 'hi'
        });
        this.threadId = threadData.thread_id;
        console.log(chalk.green(`  ✓ created new conversation: ${this.threadId}`));
      }
      
      // Save thread ID
      this.saveThreadId(this.threadId);
      
      console.log(chalk.dim('\n  ' + '─'.repeat(40)));
      console.log(chalk.dim(`  ${this.username} → ${this.targetUser}`));
      console.log(chalk.dim('  type messages below (Ctrl+C to exit)'));
      console.log(chalk.dim('  ' + '─'.repeat(40) + '\n'));
      
      // Show initial messages
      await this.fetchMessages();
      
    } catch (err) {
      console.log(chalk.red(`  [!] thread error: ${err.message}`));
      process.exit(1);
    }
  }

  async startPolling() {
    this.pollInterval = setInterval(async () => {
      try {
        if (this.isLoggedIn) {
          await this.fetchMessages();
        }
      } catch (e) {
        // Silently handle polling errors
      }
    }, 3000);
  }

  async fetchMessages() {
    if (!this.threadId || !this.isLoggedIn) return;
    
    try {
      const thread = await this.ig.direct.thread.get(this.threadId);
      const messages = thread.items || [];
      
      // Filter new messages
      const newMessages = messages
        .filter(m => {
          if (this.lastMessageId && m.item_id <= this.lastMessageId) return false;
          return true;
        })
        .slice(0, 10)
        .reverse();
      
      if (newMessages.length > 0) {
        // Clear the current line
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        
        for (const msg of newMessages) {
          const isMe = msg.user_id === this.ig.state.cookieUserId;
          const sender = isMe ? this.username : this.targetUser;
          const text = msg.text || msg.content || '[media]';
          
          // Format message
          const time = new Date(msg.timestamp * 1000).toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          
          if (isMe) {
            console.log(chalk.dim(`  ${time}`) + chalk.gray(`  ${text}`));
          } else {
            console.log(chalk.dim(`  ${time}`) + chalk.white(`  ${text}`));
          }
          
          // Update last message ID
          if (msg.item_id > this.lastMessageId || !this.lastMessageId) {
            this.lastMessageId = msg.item_id;
          }
        }
        
        // Redraw prompt
        process.stdout.write(chalk.dim('  > '));
      }
      
    } catch (err) {
      // Silently handle errors
    }
  }

  async sendMessage(text) {
    if (!text || !text.trim()) return;
    if (!this.threadId || !this.isLoggedIn) return;
    
    // Handle commands
    if (text.startsWith('/')) {
      this.handleCommand(text);
      return;
    }
    
    try {
      await this.ig.direct.thread.broadcast({
        threadId: this.threadId,
        text: text.trim()
      });
      
      // Clear prompt line
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      
      // Show sent message
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      console.log(chalk.dim(`  ${time}`) + chalk.gray(`  ${text.trim()}`));
      
      // Redraw prompt
      process.stdout.write(chalk.dim('  > '));
      
    } catch (err) {
      console.log(chalk.red(`\n  [!] send failed: ${err.message}`));
      process.stdout.write(chalk.dim('  > '));
    }
  }

  handleCommand(cmd) {
    if (cmd === '/clear' || cmd === '/c') {
      console.clear();
      console.log(chalk.dim(`  ${this.username} → ${this.targetUser}`));
      console.log(chalk.dim('  type messages below (Ctrl+C to exit)\n'));
      process.stdout.write(chalk.dim('  > '));
    } else if (cmd === '/status' || cmd === '/s') {
      console.log(chalk.dim('\n  status:'));
      console.log(chalk.dim(`  username: ${this.username}`));
      console.log(chalk.dim(`  target: ${this.targetUser}`));
      console.log(chalk.dim(`  thread: ${this.threadId}`));
      console.log(chalk.dim(`  connected: ${this.isLoggedIn ? 'yes' : 'no'}`));
      console.log(chalk.dim(`  messages: ${this.lastMessageId || 0}\n`));
      process.stdout.write(chalk.dim('  > '));
    } else if (cmd === '/help' || cmd === '/h') {
      console.log(chalk.dim('\n  commands:'));
      console.log(chalk.dim('  /clear, /c  - clear screen'));
      console.log(chalk.dim('  /status, /s - show status'));
      console.log(chalk.dim('  /help, /h   - show this help'));
      console.log(chalk.dim('  /exit, /q   - quit\n'));
      process.stdout.write(chalk.dim('  > '));
    } else if (cmd === '/exit' || cmd === '/q') {
      this.cleanup();
      process.exit(0);
    } else if (cmd === '/reconnect' || cmd === '/r') {
      console.log(chalk.dim('\n  reconnecting...'));
      this.isLoggedIn = false;
      setTimeout(async () => {
        await this.login();
      }, 1000);
    } else {
      console.log(chalk.dim(`\n  unknown command: ${cmd}`));
      console.log(chalk.dim('  type /help for available commands\n'));
      process.stdout.write(chalk.dim('  > '));
    }
  }

  handleInput() {
    // Show initial prompt
    process.stdout.write(chalk.dim('  > '));
    
    this.rl.on('line', async (line) => {
      await this.sendMessage(line);
    });
  }

  cleanup() {
    this.isLoggedIn = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log(chalk.dim('\n  exiting...\n'));
  }
}

// Run the client
(async () => {
  const client = new InstagramTerminalClient();
  await client.login();
})();