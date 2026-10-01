# Instagram DM Bridge

> **Automation project** – scrape Instagram followers, cache thread IDs, and open direct message threads automatically.

## 📌 Overview
This repository implements a **headless automation tool** using **Node.js**, **Puppeteer**, and **Express**. The workflow:
1. **Login** to Instagram via a stored session.
2. **Scrape** the list of accounts a target user follows (via the modal that appears after clicking the *Followers* button).
3. **Cache** usernames and their thread IDs in two JSON files:
   - `server/.thread_id.json` – simple `{"username": "threadId"}` map.
   - `server/.threads_cache.json` – richer objects (`username`, `displayName`, `threadId`, `updatedAt`).
4. When a **target username** is requested, the tool:
   - Checks the cache. If a thread ID exists, it **navigates directly** to `https://www.instagram.com/direct/t/<threadId>/`.
   - If the ID is `null`, it **opens the New Message modal**, types the username, selects the correct result, clicks *Chat/Next*, extracts the thread URL, stores the ID and **returns to the thread**.

The whole process runs **without manual UI interaction**, making it ideal for bots that need to send automated messages or gather conversation histories.

---

## 🛠️ Tech Stack
| Layer | Technology |
|---|---|
| **Runtime** | Node.js (v18+), npm |
| **Browser Automation** | Puppeteer (headless Chrome) |
| **Web Server** | Express.js |
| **Data Persistence** | JSON files (`.thread_id.json`, `.threads_cache.json`) |
| **Development** | TypeScript (compiled to JavaScript) |
| **Logging** | Console + simple file writes |

---

## 🚀 Getting Started
```bash
# Clone the repo
git clone https://github.com/yourname/instagram-dm-bridge.git
cd instagram-dm-bridge

# Install dependencies
npm install

# Build TypeScript
npm run compile   # runs `tsc -p ./`

# Start the server (you need a logged‑in Instagram session – see docs/login.md)
npm start
```
The server will listen on `http://localhost:3000` and expose the following endpoints:
- `POST /login` – authenticate and save the session.
- `GET /threads` – list cached users.
- `POST /select-target` – request a specific user; the server will navigate, scrape, and return the thread URL.
- `POST /sync-following` – refresh the follower list and update caches.

---

## 📊 Automation Flow (Diagram)
```mermaid
flowchart TD
    A[Start] --> B[Load .thread_id.json & .threads_cache.json]
    B --> C{Is threadId cached?}
    C -- Yes --> D[Navigate direct to /direct/t/<id>/]
    C -- No --> E[Goto /direct/new/]
    E --> F[Wait for search input]
    F --> G[Type username]
    G --> H[Select result row (exact/partial match)]
    H --> I[Click Chat/Next]
    I --> J[Extract threadId from URL]
    J --> K[Save threadId to both JSON files]
    K --> L[Navigate to thread page]
    D & L --> M[Done]
```
---

## 🧩 Extending the Project
- **Add message sending**: use `page.type` on the textarea inside `/direct/t/<id>/` and click the *Send* button.
- **Persist sessions** with `puppeteer-extra-plugin-stealth` to avoid detection.
- **Scale** by storing caches in a proper DB (SQLite, MongoDB) instead of flat JSON.
- **Schedule** periodic syncs via the `/schedule` slash‑command or a cron job.

---

## 📚 Documentation
- `docs/login.md` – how to generate a session cookie.
- `docs/api.md` – full API spec.
- `docs/automation.md` – deeper dive into the Puppeteer selectors and timing nuances.

---

## 🤝 Contributing
1. Fork the repo.
2. Create a feature branch (`git checkout -b feat/your‑feature`).
3. Ensure `npm run lint` passes.
4. Submit a Pull Request with a clear description of the change.

---

## 📄 License
MIT – feel free to use, modify, and distribute.

---

*Happy automating!*
