# Publishing LocaLingo on the Chrome Web Store

Chrome only installs extensions with one click (or offers them automatically) when
they come from the Chrome Web Store. Until LocaLingo is listed there, the installer
puts an unpacked copy in `~/LocaLingo/chrome-extension` and users load it once in
Developer mode. After publishing, the installer can register the store build so
Chrome itself offers it: the user only clicks **Enable**.

## 1. Developer account (once)

Register at <https://chrome.google.com/webstore/devconsole> with the Google account
that should own the listing (one-time US$5 fee). Verify the contact email.

## 2. Package

```bash
bash scripts/build_release.sh   # data/release/localingo-extension.zip
```

Upload `data/release/localingo-extension.zip` as a new item. Bump `version` in
`extension/manifest.json` for every later upload.

## 3. Store listing

- **Name:** LocaLingo
- **Summary (≤132 chars):** 在网页上读英文：本机模型翻译、离线查词、带语境收藏生词并按间隔复习。
- **Category:** Education
- **Language:** 中文（简体）
- **Description:**

  > LocaLingo 帮你直接读英文网页，并把读到的生词留下来。
  >
  > · 本机翻译：英译中由你 Mac 上的本地模型完成，网页内容不上传。需要先在
  >   http://101.35.6.63:8083/#install 运行一键安装。
  > · 学习阅读：先读原文，只在需要时点开某一段的中文；也可以双语对照或只看译文。
  > · 离线查词：选中单词或短语即可查词，词典安装在浏览器里。
  > · 带语境收藏：生词连同原句和来源一起保存，在学习中心整理、按间隔复习，
  >   扩展和网页版通过 LocaLingo 账号同步。
  >
  > 需要 Apple Silicon Mac。

- **Icon:** `extension/icons/icon128.png`
- **Screenshots (1280×800):** a translated article in 双语对照, the lookup card on a
  selected word, the popup, the learning center review page.
- **Privacy policy URL:** `http://101.35.6.63:8083/privacy.html`
- **Homepage URL:** `http://101.35.6.63:8083/`

## 4. Privacy practices tab

- **Single purpose:** Help users read English web pages: translate page text with a
  local model, look up words offline, and save words with their context for review.
- **Permission justifications:**
  - `activeTab`, `scripting`: inject the reader into the current tab when the user
    opens the popup on a tab that was open before installation.
  - `contextMenus`: right-click "翻译成中文" / "在 LocaLingo 中查词".
  - `storage`, `unlimitedStorage`: settings, translation cache and the offline
    dictionary (~25 MB).
  - `sidePanel`: the learning side panel.
  - `tts`: pronounce words with the system's local voices.
  - `alarms`: periodic vocabulary sync.
  - Host `http://127.0.0.1/*`, `http://localhost/*`: the translation service on the
    user's own Mac.
  - Host `http://101.35.6.63:8083/*`: account sign-in, vocabulary sync, dictionary
    download.
  - Content scripts on all sites: show translations and the word-lookup bar on the
    pages the user reads.
- **Remote code:** No (all JavaScript is in the package).
- **Data usage:** "Personally identifiable information" (username) and "Website
  content" (the sentences/URLs the user chooses to save) — used only for the
  extension's functionality, not sold, not used for unrelated purposes.

Reviewers dislike plain-HTTP backends for account data. Moving the server to a
domain with HTTPS first (update `ACCOUNT_SERVER` in `extension/learning/sync.js`, the
host permission in `manifest.json`, `INSTALL_PAGE` in `extension/popup.js`) makes
approval more likely and protects passwords.

## 5. After approval: one-click install

Copy the item ID (32 letters, from the store URL) into `STORE_ID` in
`scripts/install-macos.sh`, rebuild (`scripts/build_release.sh`) and deploy
`data/release/`. The installer then writes
`~/Library/Application Support/Google/Chrome/External Extensions/<ID>.json`
(`external_update_url` = the Web Store), restarts Chrome, and Chrome shows
"LocaLingo 已添加" with an **Enable** button. Store updates reach users
automatically. The website's install steps should then drop the Developer-mode
step.
