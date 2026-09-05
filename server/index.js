const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3421;

app.use(cors({ origin: '*' }));
app.use(express.json());

let browser = null;
let page = null;
let isLoggedIn = false;
let currentUsername = '';
let targetUser = '';
let targetThreadId = null;
let cachedMessages = [];
let currentCredentials = null;

const CREDS_FILE = path.join(__dirname, '.igdm_session.json');
const THREAD_ID_FILE = path.join(__dirname, '.thread_id.json');
const THREADS_CACHE_FILE = path.join(__dirname, '.threads_cache.json');

function getChromeExecutablePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // Puppeteer bundled Chromium fallback
}

function loadCreds() {
  if (fs.existsSync(CREDS_FILE)) {
    try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch (e) {}
  }
  return null;
}

function saveCreds(creds) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

function loadThreadIdsMap() {
  if (fs.existsSync(THREAD_ID_FILE)) {
    try { return JSON.parse(fs.readFileSync(THREAD_ID_FILE, 'utf8')); } catch (e) {}
  }
  return {};
}

function saveThreadId(user, threadId) {
  const map = loadThreadIdsMap();
  map[user] = String(threadId);
  fs.writeFileSync(THREAD_ID_FILE, JSON.stringify(map, null, 2));
}

function loadThreadsCache() {
  const threadMap = loadThreadIdsMap();
  const cachedList = [];
  
  if (fs.existsSync(THREADS_CACHE_FILE)) {
    try { cachedList.push(...JSON.parse(fs.readFileSync(THREADS_CACHE_FILE, 'utf8'))); } catch (e) {}
  }

  // Merge usernames from .thread_id.json — only add missing users, never overwrite existing threadId
  for (const [user, tid] of Object.entries(threadMap)) {
    const validTid = (tid && tid !== 'null' && tid !== 'undefined' && tid !== null) ? tid : null;
    const existing = cachedList.find(c => c.username.toLowerCase() === user.toLowerCase());
    
    if (!existing) {
      // Add new user with threadId from map
      cachedList.push({
        username: user,
        displayName: user,
        threadId: validTid,
        updatedAt: Date.now()
      });
    } else {
      // Only fill in threadId if cache entry currently has none — never overwrite a stored value!
      if (!existing.threadId || existing.threadId === 'null' || existing.threadId === 'undefined') {
        existing.threadId = validTid;
      }
    }
  }
  return cachedList;
}

function saveThreadsCache(threads) {
  fs.writeFileSync(THREADS_CACHE_FILE, JSON.stringify(threads, null, 2));
}

function waitForTimeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isUserLoggedIn(page) {
  try {
    const loggedInIndicators = [
      'svg[aria-label="Home"]',
      'svg[aria-label="Direct"]',
      'a[href="/direct/inbox/"]'
    ];
    
    for (const selector of loggedInIndicators) {
      const element = await page.$(selector);
      if (element) return true;
    }
    
    const url = page.url();
    if (!url.includes('/accounts/login') && url !== 'https://www.instagram.com/') {
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

// Stage 1: Login Route
app.post('/login', async (req, res) => {
  const { username, password, target } = req.body || {};
  
  if (username && password) {
    currentCredentials = { username, password, target: target || '' };
    saveCreds(currentCredentials);
  } else {
    currentCredentials = loadCreds();
  }

  if (!currentCredentials || !currentCredentials.username || !currentCredentials.password) {
    return res.status(400).json({ error: 'Missing credentials. Please configure via the panel.' });
  }

  currentUsername = currentCredentials.username;
  console.log(`[igdm] Logging in for @${currentUsername}...`);

  try {
    if (!browser || !browser.isConnected()) {
      const profileDir = path.join(__dirname, 'chrome-profile');
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      const execPath = getChromeExecutablePath();
      console.log('[igdm] Launching browser path:', execPath || 'bundled chromium');

      const launchOpts = {
        headless: false,
        defaultViewport: null,
        userDataDir: profileDir,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
      };
      if (execPath) launchOpts.executablePath = execPath;

      browser = await puppeteer.launch(launchOpts);
      const pages = await browser.pages();
      page = pages[0] || await browser.newPage();
    }

    console.log('[igdm] Navigating to Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForTimeout(2000);

    let loggedIn = await isUserLoggedIn(page);
    
    if (!loggedIn) {
      console.log('[igdm] Entering credentials...');
      const usernameField = await page.$('input[name="username"]');
      if (!usernameField) throw new Error('Could not find login form');

      await usernameField.click({ clickCount: 3 });
      await usernameField.type(currentCredentials.username, { delay: 60 });
      
      const passwordField = await page.$('input[name="password"]');
      await passwordField.click({ clickCount: 3 });
      await passwordField.type(currentCredentials.password, { delay: 60 });
      
      await page.keyboard.press('Enter');
      await waitForTimeout(4000);
      
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (e) {}

      loggedIn = await isUserLoggedIn(page);
      if (!loggedIn) {
        throw new Error('Authentication failed. Check credentials or 2FA prompt.');
      }
    }

    isLoggedIn = true;
    console.log(`[igdm] Logged in successfully as @${currentUsername}`);

    res.json({ ok: true, username: currentUsername });
  } catch (err) {
    console.error('[igdm] Login error:', err.message);
    isLoggedIn = false;
    res.status(401).json({ error: err.message });
  }
});

// Stage 2: Sync Following List from Profile Modal into JSON
app.post('/sync-threads', async (req, res) => {
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    console.log(`[igdm] Navigating to @${currentUsername}'s profile...`);
    await page.goto(`https://www.instagram.com/${currentUsername}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForTimeout(2500);

    console.log('[igdm] Locating Following button...');
    const clickedFollowing = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/following/"], button, div[role="button"]'));
      const btn = links.find(l => {
        const txt = l.textContent ? l.textContent.toLowerCase() : '';
        const href = l.getAttribute('href') || '';
        return href.includes('/following/') || txt.includes('following');
      });
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clickedFollowing) {
      console.log('[igdm] Direct button click missed, navigating to /following/...');
      await page.goto(`https://www.instagram.com/${currentUsername}/following/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    await waitForTimeout(3000);

    console.log('[igdm] Auto-scrolling following modal popup...');
    await page.evaluate(async () => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return;
      const scrollable = dialog.querySelector('div[style*="overflow"], div[class*="x1n2onr6"]') || dialog;
      for (let i = 0; i < 6; i++) {
        scrollable.scrollTop += 600;
        await new Promise(r => setTimeout(r, 600));
      }
    });

    await waitForTimeout(1500);

    const scrapedFollowing = await page.evaluate((myUname) => {
      const results = [];
      const dialog = document.querySelector('div[role="dialog"]') || document.body;
      const links = Array.from(dialog.querySelectorAll('a[href]'));

      const ignored = [
        'explore', 'reels', 'direct', 'stories', 'accounts', 'developer',
        'about', 'legal', 'terms', 'privacy', 'help', 'api', 'jobs', myUname.toLowerCase()
      ];

      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
        if (match) {
          const uname = match[1].trim();
          if (uname && !ignored.includes(uname.toLowerCase()) && !uname.startsWith('?')) {
            const textContent = link.textContent ? link.textContent.trim() : '';
            results.push({
              username: uname,
              displayName: textContent || uname,
              threadId: null,
              updatedAt: Date.now()
            });
          }
        }
      });

      const unique = [];
      const seen = new Set();
      results.forEach(u => {
        const key = u.username.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(u);
        }
      });
      return unique;
    }, currentUsername);

    console.log(`[igdm] Extracted ${scrapedFollowing.length} following users from modal popup.`);

    const threadMap = loadThreadIdsMap();
    scrapedFollowing.forEach(u => {
      if (!threadMap.hasOwnProperty(u.username)) {
        threadMap[u.username] = "null";
      }
    });
    fs.writeFileSync(THREAD_ID_FILE, JSON.stringify(threadMap, null, 2));

    const mergedThreads = loadThreadsCache();
    saveThreadsCache(mergedThreads);

    console.log(`[igdm] Loaded total ${mergedThreads.length} users into thread list.`);
    res.json({ ok: true, count: mergedThreads.length, threads: mergedThreads });
  } catch (err) {
    console.error('[igdm] Sync following error:', err.message);
    const fallback = loadThreadsCache();
    res.json({ ok: true, count: fallback.length, threads: fallback, cached: true });
  }
});

// GET /threads (read all usernames from .thread_id.json & .threads_cache.json)
app.get('/threads', (req, res) => {
  const threads = loadThreadsCache();
  res.json({ ok: true, count: threads.length, threads });
});

// Stage 3: Select Target User — direct thread if cached, else inbox search flow
app.post('/select-target', async (req, res) => {
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { targetUser: inputTarget } = req.body || {};
  if (!inputTarget) {
    return res.status(400).json({ error: 'Missing target user' });
  }

  // Always reset target state per request — prevent reuse of a previous user's state
  targetUser = inputTarget;
  targetThreadId = null;

  try {
    // --- Read BOTH files fresh on every request ---
    const threadMap = loadThreadIdsMap();
    const cache = JSON.parse(
      fs.existsSync(THREADS_CACHE_FILE)
        ? fs.readFileSync(THREADS_CACHE_FILE, 'utf8')
        : '[]'
    );

    // Look up THIS specific user's thread ID (case-insensitive key search)
    let existingTid = null;

    // Check .thread_id.json first (source of truth)
    const mapKey = Object.keys(threadMap).find(k => k.toLowerCase() === inputTarget.toLowerCase());
    if (mapKey) {
      const val = threadMap[mapKey];
      if (val && val !== 'null' && val !== 'undefined' && val !== null) {
        existingTid = String(val);
      }
    }

    // Fallback: check .threads_cache.json
    if (!existingTid) {
      const cacheEntry = cache.find(t => t.username.toLowerCase() === inputTarget.toLowerCase());
      if (cacheEntry && cacheEntry.threadId && cacheEntry.threadId !== 'null' && cacheEntry.threadId !== 'undefined') {
        existingTid = String(cacheEntry.threadId);
      }
    }

    if (existingTid) {
      // ✅ Thread ID found — navigate DIRECTLY, no search needed
      targetThreadId = existingTid;
      console.log(`[igdm] ✅ Thread ID for @${targetUser} found: ${targetThreadId} → navigating directly...`);

    } else {
//       // ❌ Thread ID is null — run: inbox → /direct/new/ → search → ArrowDown+Enter → extract URL
//       console.log(`[igdm] ❌ Thread ID for @${targetUser} is NULL → running search flow...`);

//       // Step 1: Navigate directly to /direct/new/ (most reliable — no SVG button needed)
//       console.log('[igdm] Step 1: Navigating to https://www.instagram.com/direct/inbox/ ...');
//       await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20000 });
//       await waitForTimeout(2000);

//       // Step 2: Wait for the search input to appear
//       console.log('[igdm] Step 2: Waiting for search input...');
//       const SEARCH_INPUT_SEL = 'input[placeholder*="Search"], input[placeholder*="search"], input[aria-label*="Search"]';
//       let searchInput = null;
//       try {
//         await page.waitForSelector(SEARCH_INPUT_SEL, { timeout: 10000 });
//         searchInput = await page.$(SEARCH_INPUT_SEL);
//       } catch (e) {
//         // Fallback: first input on page
//         searchInput = await page.$('input[type="text"], input:not([type="hidden"])');
//       }

//       if (!searchInput) {
//         throw new Error('Could not find search input on /direct/new/ page');
//       }

//       // Step 3: Click input, clear it, then type the target username
//       console.log(`[igdm] Step 3: Typing @${targetUser} into search box...`);
//       await searchInput.click({ clickCount: 3 });
//       await waitForTimeout(200);
//       await searchInput.press('Backspace');
//       await waitForTimeout(100);
//       await page.keyboard.type(targetUser, { delay: 80 });

//       // Step 4: Wait for search results to appear
//       console.log('[igdm] Step 4: Waiting for results (2.5s)...');
//       await waitForTimeout(2500);

//       // Step 5: Find and click the search result matching targetUser
//       console.log(`[igdm] Step 5: Looking for search result matching "${targetUser}"...`);
      
//       const userClicked = await page.evaluate((targetUser) => {
//         const target = targetUser.toLowerCase().trim();
      
//         // Instagram search results are typically rendered as list items/rows
//         // containing spans/divs with the username text. We scan candidate
//         // clickable containers and match on visible text.
//         const candidates = Array.from(
//           document.querySelectorAll('div[role="button"], li, a, div[role="option"]')
//         );
      
//         // Find the best match: exact username match preferred, then partial
//         let exactMatch = null;
//         let partialMatch = null;
      
//         for (const el of candidates) {
//           const txt = (el.textContent || '').toLowerCase().trim();
//           if (!txt) continue;
      
//           // Skip huge containers (likely wrap the whole list, not a single row)
//           if (txt.length > 200) continue;
      
//           if (txt === target || txt.split(/\s+/).includes(target)) {
//             exactMatch = el;
//             break;
//           }
//           if (!partialMatch && txt.includes(target)) {
//             partialMatch = el;
//           }
//         }
      
//         const match = exactMatch || partialMatch;
//         if (match) {
//           match.click();
//           return true;
//         }
//         return false;
//       }, targetUser);
      
//       if (userClicked) {
//         console.log(`[igdm] Clicked search result for "${targetUser}"`);
//       } else {
//         console.log(`[igdm] No exact match found for "${targetUser}", falling back to ArrowDown+Enter...`);
//         await page.keyboard.press('ArrowDown');
//         await waitForTimeout(400);
//         await page.keyboard.press('Enter');
//       }
//       await waitForTimeout(600);

// // // Step 6: Click the Chat / Next button
// // console.log('[igdm] Step 6: Clicking Chat / Next button...');
// // const chatClicked = await page.evaluate(() => {
// //   const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
// //   const chatBtn = btns.find(b => {
// //     const txt = (b.textContent || '').toLowerCase().trim();
// //     return txt === 'chat' || txt === 'next';
// //   });
// //   if (chatBtn) { chatBtn.click(); return true; }
// //   return false;
// // });
// // if (!chatClicked) {
// //   console.log('[igdm] Chat/Next button not found, trying keyboard Enter...');
// //   await page.keyboard.press('Enter');
// //}

//       // // Step 6: Click the Chat / Next button
//       // console.log('[igdm] Step 6: Clicking Chat / Next button...');
//       // const chatClicked = await page.evaluate(() => {
//       //   const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
//       //   const chatBtn = btns.find(b => {
//       //     const txt = (b.textContent || '').toLowerCase().trim();
//       //     return txt === 'chat' || txt === 'next';
//       //   });
//       //   if (chatBtn) { chatBtn.click(); return true; }
//       //   return false;
//       // });
//       // if (!chatClicked) {
//       //   console.log('[igdm] Chat/Next button not found, trying keyboard Enter...');
//       //   await page.keyboard.press('Enter');
//       // }

//       // Step 7: Poll URL for /direct/t/<threadId>/
//       console.log('[igdm] Step 7: Polling URL for thread ID...');
//       for (let i = 0; i < 24; i++) {
//         await waitForTimeout(500);
//         const currentUrl = page.url();
//         const match = currentUrl.match(/\/direct\/t\/(\d+)/);
//         if (match) {
//           targetThreadId = String(match[1]);
//           console.log(`[igdm] ✅ Extracted thread ID ${targetThreadId} for @${targetUser}!`);
//           break;
//         }
//       }

//       if (!targetThreadId) {
//         throw new Error(`Could not extract thread ID from URL for @${targetUser} — search may have returned wrong user`);
//       }

//       // Step 8: Persist to both files
//       console.log(`[igdm] Step 8: Saving thread ID ${targetThreadId} for @${targetUser}...`);
//       saveThreadId(targetUser, targetThreadId);

//       const updatedCache = cache.map(item =>
//         item.username.toLowerCase() === targetUser.toLowerCase()
//           ? { ...item, threadId: targetThreadId, updatedAt: Date.now() }
//           : item
//       );
//       if (!updatedCache.some(item => item.username.toLowerCase() === targetUser.toLowerCase())) {
//         updatedCache.push({ username: targetUser, displayName: targetUser, threadId: targetThreadId, updatedAt: Date.now() });
//       }
//       saveThreadsCache(updatedCache);
         // ❌ Thread ID is null → run Explore‑based search flow
         console.log(`[igdm] ❌ Thread ID for @${targetUser} is NULL → running explore‑based search flow...`);
         
         // Step 1: Go to Explore page
         console.log('[igdm] Step 1: Navigating to https://www.instagram.com/explore/ ...');
         await page.goto('https://www.instagram.com/explore/', {
           waitUntil: 'networkidle2',
           timeout: 20000
         });
         await waitForTimeout(2000);
         
         // Step 2: Locate search input
         console.log('[igdm] Step 2: Locating global search input...');
         const searchInputSelector = 'input[aria-label="Search input"], input[placeholder="Search"], input[aria-label="Search"]';
         try {
           await page.waitForSelector(searchInputSelector, { timeout: 15000, visible: true });
         } catch (e) {
           throw new Error('Global search input not found on Explore page');
         }
         const searchInput = await page.$(searchInputSelector);
         if (!searchInput) throw new Error('Search input element not found');
         
         // Clear and type
         await searchInput.click({ clickCount: 3 });
         await waitForTimeout(200);
         await searchInput.press('Backspace');
         await waitForTimeout(100);
         await page.keyboard.type(targetUser, { delay: 80 });
         
         // Step 3: Wait for search dropdown
         console.log('[igdm] Step 3: Waiting for search dropdown...');
         const dropdownSelector = 'div[role="menu"], div[role="listbox"], div[class*="x1n2onr6"]';
         try {
           await page.waitForSelector(dropdownSelector, { timeout: 5000 });
         } catch (e) {
           console.warn('[igdm] Dropdown not detected; proceeding anyway...');
         }
         await waitForTimeout(1000);
         
         // Step 4: ArrowDown + Enter
         console.log('[igdm] Step 4: Pressing ArrowDown + Enter to select first result...');
         await page.keyboard.press('ArrowDown');
         await waitForTimeout(400);
         await page.keyboard.press('Enter');
         
         // Step 5: Wait for profile navigation
         console.log(`[igdm] Step 5: Waiting for profile page of @${targetUser}...`);
         try {
           await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
         } catch (e) {
           const currentUrl = page.url();
           if (!currentUrl.includes(`/${targetUser}/`)) {
             throw new Error(`Failed to navigate to @${targetUser}'s profile`);
           }
         }
         await waitForTimeout(2000);
         
         // Step 6: Click Message button
         console.log('[igdm] Step 6: Clicking Message button on profile...');
         const messageClicked = await page.evaluate(() => {
           const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
           for (const btn of buttons) {
             const txt = (btn.textContent || '').trim();
             if (txt === 'Message') {
               btn.click();
               return true;
             }
           }
           return false;
         });
         if (!messageClicked) {
           throw new Error('Message button not found on profile');
         }
         
         // Step 7: Wait for DM popup and click Expand (revised)
         console.log('[igdm] Step 7: Waiting for DM popup...');
         try {
           await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });
         } catch (e) {
           console.warn('[igdm] DM popup dialog not found; continuing anyway...');
         }
         await waitForTimeout(1500);
         
         console.log('[igdm] Step 7b: Locating and clicking Expand button...');
         const expandClicked = await page.evaluate(() => {
           // Find the SVG with aria-label="Expand"
           const svg = document.querySelector('svg[aria-label="Expand"]');
           if (!svg) return false;
         
           // Try to find a clickable parent
           let clickable = svg.closest('div[role="button"], button, a');
           if (!clickable) {
             clickable = svg; // fallback: click the SVG itself
           }
           clickable.click();
           return true;
         });
         
         if (!expandClicked) {
           console.warn('[igdm] Expand button not found; trying alternative...');
           const altClicked = await page.evaluate(() => {
             const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
             for (const btn of buttons) {
               const svg = btn.querySelector('svg[aria-label="Expand"]');
               if (svg) {
                 btn.click();
                 return true;
               }
             }
             return false;
           });
           if (!altClicked) {
             console.warn('[igdm] Still cannot find Expand; pressing Enter as fallback...');
             await page.keyboard.press('Enter');
           }
         }
         
         // Step 8: Poll URL for thread ID
         console.log('[igdm] Step 8: Polling URL for thread ID...');
         let threadIdExtracted = null;
         for (let i = 0; i < 30; i++) {
           await waitForTimeout(500);
           const currentUrl = page.url();
           const match = currentUrl.match(/\/direct\/t\/(\d+)/);
           if (match) {
             threadIdExtracted = String(match[1]);
             console.log(`[igdm] ✅ Extracted thread ID ${threadIdExtracted} for @${targetUser}`);
             break;
           }
         }
         if (!threadIdExtracted) {
           throw new Error(`Could not extract thread ID from URL for @${targetUser}`);
         }
         targetThreadId = threadIdExtracted;
         
         // Step 9: Persist thread ID
         saveThreadId(targetUser, targetThreadId);
         const cache = JSON.parse(
           fs.existsSync(THREADS_CACHE_FILE)
             ? fs.readFileSync(THREADS_CACHE_FILE, 'utf8')
             : '[]'
         );
         const updatedCache = cache.map(item =>
           item.username.toLowerCase() === targetUser.toLowerCase()
             ? { ...item, threadId: targetThreadId, updatedAt: Date.now() }
             : item
         );
         if (!updatedCache.some(item => item.username.toLowerCase() === targetUser.toLowerCase())) {
           updatedCache.push({ username: targetUser, displayName: targetUser, threadId: targetThreadId, updatedAt: Date.now() });
         }
         saveThreadsCache(updatedCache);
    }

    // Final navigation: always go directly to the thread URL
    console.log(`[igdm] Navigating to /direct/t/${targetThreadId}/ for @${targetUser}...`);
    await page.goto(`https://www.instagram.com/direct/t/${targetThreadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForTimeout(1500);

    res.json({ ok: true, targetUser, threadId: targetThreadId });
  } catch (err) {
    console.error('[igdm] Select target error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /messages
app.get('/messages', async (req, res) => {
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    // Ensure we are on the right thread page
    if (targetThreadId) {
      const url = page.url();
      if (!url.includes(`/direct/t/${targetThreadId}`)) {
        await page.goto(`https://www.instagram.com/direct/t/${targetThreadId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForTimeout(2000);
      }
    }

    // Scrape messages with better sender detection
    const messages = await page.evaluate(() => {
      const results = [];
      
      // Find the message container – Instagram uses a div with role="feed" or a class like "x1n2onr6"
      // We'll try multiple selectors.
      let container = document.querySelector('div[role="feed"]');
      if (!container) {
        // Fallback: find the scrollable message area (often the only div with overflow-y)
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const style = window.getComputedStyle(div);
          if (style.overflowY === 'auto' && div.children.length > 0) {
            container = div;
            break;
          }
        }
      }
      if (!container) {
        // Last fallback: use the whole body
        container = document.body;
      }

      // Look for message rows – each message is typically in a div with role="row"
      const messageRows = container.querySelectorAll('div[role="row"]');
      
      for (const row of messageRows) {
        // Find the actual text span(s) inside the row – messages are usually inside span[dir="auto"]
        const textSpans = row.querySelectorAll('span[dir="auto"]');
        let fullText = '';
        for (const span of textSpans) {
          const txt = span.textContent ? span.textContent.trim() : '';
          if (txt && txt.length > 0 && txt.length < 500) {
            fullText += txt + ' ';
          }
        }
        fullText = fullText.trim();
        if (!fullText) continue;

        // Skip system messages like "seen", "reply", etc.
        if (fullText.includes('seen') || fullText.includes('reply') || fullText.includes('typing')) continue;

        // Determine sender:
        // 1. Check for class "outgoing" (if present)
        // 2. Otherwise, check alignment: messages from other user are usually left-aligned (flex-start),
        //    while own are right-aligned (flex-end).
        // 3. Also check for data attributes or parent classes.
        let sender = 'them'; // default
        
        // Check if row or any parent has a class indicating outgoing
        const hasOutgoing = row.closest('[class*="outgoing"]') !== null;
        if (hasOutgoing) {
          sender = 'me';
        } else {
          // Check computed style of the row's parent container (the message bubble)
          const bubble = row.querySelector('div[class*="x1n2onr6"]') || row;
          const style = window.getComputedStyle(bubble);
          // In many cases, the parent container uses flex with justify-content: flex-end for own messages
          const justifyContent = style.justifyContent || '';
          if (justifyContent.includes('flex-end') || justifyContent.includes('end')) {
            sender = 'me';
          } else if (justifyContent.includes('flex-start') || justifyContent.includes('start')) {
            sender = 'them';
          } else {
            // Additional check: own messages often have a class like "x1n2onr6" (specific to right side)
            // We can try to find a child with a specific background color (Instagram uses blue for own)
            const bg = window.getComputedStyle(bubble).backgroundColor;
            if (bg && bg.includes('rgb(0, 149, 246)')) { // Instagram blue
              sender = 'me';
            }
          }
        }

        results.push({
          id: fullText + Date.now() + Math.random(),
          text: fullText,
          sender: sender,
          timestamp: Date.now()
        });
      }

      // Remove duplicates (by text)
      const unique = [];
      const seen = new Set();
      for (const msg of results) {
        if (!seen.has(msg.text)) {
          seen.add(msg.text);
          unique.push(msg);
        }
      }
      return unique.slice(-50); // return last 50 messages
    });

    if (messages.length > 0) cachedMessages = messages;
    res.json({ ok: true, messages: cachedMessages });
  } catch (err) {
    console.error('[igdm] Messages error:', err.message);
    res.json({ ok: true, messages: cachedMessages });
  }
});

// POST /send
app.post('/send', async (req, res) => {
  if (!isLoggedIn || !page) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Empty message' });
  }

  try {
    const textarea = await page.$('textarea, div[role="textbox"], [contenteditable="true"]');
    if (!textarea) throw new Error('Could not find message input on page');

    await textarea.click();
    await waitForTimeout(200);
    await page.keyboard.type(text.trim(), { delay: 50 });
    await waitForTimeout(200);
    await page.keyboard.press('Enter');

    console.log(`[igdm] Sent to @${targetUser}: "${text.trim()}"`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[igdm] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Status check
app.get('/status', (req, res) => {
  res.json({
    online: isLoggedIn,
    username: currentUsername,
    target: targetUser,
    threadId: targetThreadId,
    threadsCached: loadThreadsCache().length
  });
});

// Logout
app.post('/logout', async (req, res) => {
  if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
  if (fs.existsSync(THREAD_ID_FILE)) fs.unlinkSync(THREAD_ID_FILE);
  if (fs.existsSync(THREADS_CACHE_FILE)) fs.unlinkSync(THREADS_CACHE_FILE);

  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }

  isLoggedIn = false;
  currentUsername = '';
  targetUser = '';
  targetThreadId = null;

  res.json({ ok: true, message: 'Session logged out' });
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n[igdm] Server running on http://127.0.0.1:${PORT}`);
  console.log('[igdm] Reset target per-request & store thread ID replacing null enabled\n');
});