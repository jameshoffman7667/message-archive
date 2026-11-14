# message-archive: functional spec (current state)

Version 0.1.0. Current-state description; edit in place. Design and phase plan: `docs/architecture.md`. Pending work: `docs/pending-changes.md`.

## What it does
Keeps a permanent, searchable copy of James's Android text messages (SMS, MMS, and the RCS messages Google Messages stores as MMS), with photos, videos and audio, on the home server, so old history can later be removed from the phone (Phase 2) and put back if needed (Phase 3). Version 0.1.0 is Phase 1: read-only. Nothing on the phone is changed by this app.

## Phone side (Phase 1)
SMS Backup & Restore Pro (one app) makes a nightly incremental backup and uploads it to the app's WebDAV endpoint. Occasionally James runs a manual backup "as default SMS app" so end-to-end-encrypted RCS messages (flagged `restricted`, unreadable by scheduled backups) are included. Setup steps are on the Settings page.

## Features
- **Import** of SMS Backup & Restore files (`sms-*.xml`, or `.xml.zip` without a password) from `/inbox`, at any depth up to 4 folders. Call-log files are recognised and skipped. Sources:
  - WebDAV upload: imported as soon as the upload finishes.
  - Files copied in by hand (SMB): imported once unchanged for `SETTLE_SECONDS`, by the scan every `SCAN_INTERVAL_MINUTES` or the "Scan inbox now" button.
  - Full, incremental and archive-mode files can be mixed; each message is stored once.
- **De-duplication** by message fingerprint (`src/fingerprint.js`):
  - SMS: date (ms), type, normalized address, body.
  - MMS: date (ms), msg_box, sorted address list, and m_id/tr_id when present (otherwise the text).
  - Media is not part of the fingerprint: a later backup that carries an attachment missing from an earlier one fills it in ("completed").
  - Identical twin messages inside one file are counted (`copies`), so Phase 2 can never delete more than the archive holds.
  - Test vectors for the phone app are locked in `test/unit.test.js`.
- **Verification** per import. Status `verified` only if:
  1. records parsed = the file's `count`;
  2. every message in the file is in the database;
  3. each message has at least as many stored attachments as the file carried;
  4. every attachment file exists with the recorded size.
  New attachment files are also read back and hashed before they get their final name. Otherwise the status is `failed`, with the reasons. A failed or interrupted import can be retried from the Imports page. "Verify all media files" re-hashes the whole store.
- **Media store**: content-addressed, `/files/media/ab/cd/<sha256>`. The same bytes are stored once.
- **Conversations** are participant sets (not phone thread ids):
  - Your own numbers are learned from sent MMS (`From`) and single-recipient received MMS (`To`), plus `SELF_NUMBERS`.
  - RCS group chats (`…@rcs.google.com`) are resolved through their `<addr>` list.
  - Names come from `contact_name`, the newest wins.
- **Viewer**:
  - Conversation list (newest first, filter by name or number).
  - Threaded chat bubbles: sent on the right, sender names in groups, day separators.
  - Inline photos (tap for full screen), video and audio players, file chips for other types, and a "not in backup" chip for attachments no backup has carried yet.
  - Infinite scroll both ways, and jump to date.
- **Search**: full-text over all message text, ignoring case and accents (French included); the last word matches as a prefix. Filters: conversation, date range, only messages with media. Results show highlighted excerpts and open the thread at the message.
- **Stats**:
  - Totals, messages and attachment bytes by year.
  - Read-only preview of what is older than the cutoff (`CUTOFF_DAYS`, outside the last `KEEP_RECENT_DAYS`).
  - Counts of attachments not in any backup, and of restricted messages.
- **Settings**:
  - WebDAV password: generated and shown once, can be replaced or turned off.
  - SMS Backup & Restore setup steps.
  - Change password (signs out other sessions), sign out.
  - Install button, version, the learned own numbers.

## Screens and navigation
Chats (`/`, `/c/<id>`), Search (`/search?q=…&conv=…&from=…&to=…&media=1`), Imports (`/imports`), Stats (`/stats`), Settings (`/settings`). Every screen and the photo viewer has a history entry, so Back works in standalone mode.

## Mobile layout (< 768 px)
- One column with a bottom navigation bar (Chats, Search, Imports, Stats, Settings).
- Opening a conversation shows it full screen, with a back button and a calendar button (jump to date); the bottom bar is hidden there.
- Search results open the conversation full screen at the message.
- Touch targets are at least 44 px, and safe-area insets are respected. No sideways scrolling at 320 px.

## Tablet layout (768–1023 px)
Top navigation bar; conversation list (about 300 px) beside the open thread.

## Desktop layout (≥ 1024 px)
- Left navigation rail, a 360 px conversation or search-results column, and the thread pane using the remaining width.
- Search results stay in the left column while the thread opens on the right, with the found message highlighted.
- `/` focuses the filter or search box, `Esc` closes the photo viewer, and focus is visible.
- Imports, Stats and Settings use a centered single column.

## PWA
- Manifest:
  - `name` "Message Archive", `short_name` "Messages", `id`/`start_url`/`scope` `/`, display `standalone`.
  - Theme `#1b6ef3`, background `#f5f6f8`.
  - Icons: 192, 512, 512 maskable, and apple-touch 180.
  - Screenshots: wide 1280×720 and narrow 540×960 (demo data).
- Service worker `/sw.js`, cache `message-archive-v<version>`:
  - Precaches the app shell only; never `/api/`, `/dav/`, media or `/healthz`.
  - Navigations are network-first with `/offline.html` as the fallback.
  - When a new worker is waiting, an "Update available, Reload" prompt appears. The page reloads only on a controller change that replaces an existing worker.
- Install button: on Chrome/Edge/Android through `beforeinstallprompt`; manual steps are shown for iOS.
- **Installing needs HTTPS.** On plain `http://<LAN or Tailscale address>` everything works in the browser but cannot be installed (pending P-4).

## AI usage
AI usage: none.

## Android
Android: none (no public hostname; James chose LAN/Tailscale only on 2026-11-13). The Phase 2 phone app is a separate native app (P-2), not a TWA.

## Security
- Single user. The password is set on first run (no default), hashed with scrypt, at least 10 characters.
- Sessions are random tokens stored hashed server-side, in an HttpOnly, SameSite=Strict cookie (`Secure` when `COOKIE_SECURE=true`), with an idle timeout of `SESSION_IDLE_MINUTES`.
- Sign-in and password changes are rate-limited: 8 failures per 15 minutes per IP.
- Writes need the `X-Requested-With: fetch` header and a same-origin `Origin`.
- Strict CSP (no inline script or style), frame denial, `no-referrer`, `nosniff`.
- Media is served with `Content-Security-Policy: sandbox`. Only image, video and audio types are inline; everything else is a download.
- WebDAV:
  - Basic auth, user `archive`, its own password (scrypt), 10 failures per 15 minutes per IP.
  - Confined to `/inbox`; hidden names, `..` and escapes are refused.
  - Uploads go to a temp file and are then renamed.
- Forwarded headers are trusted only from private networks. Nothing is logged that contains message content or passwords.
- Not reachable from outside the house except through Tailscale. The public-exposure baseline (TOTP, Cloudflare Access) is not implemented, so the app must not get a public hostname without P-4.

## Configuration (environment)
| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8080 (dev) | Listen port; the server sets it to the assigned host port |
| `DATA_DIR` | /data | SQLite database (fast disk) |
| `FILES_DIR` | /files | Media store (pool) |
| `INBOX_DIR` | /inbox | Backup drop folder (dump_truck `AppData/message-archive-inbox`) |
| `COOKIE_SECURE` | false | true only when served over HTTPS |
| `SESSION_IDLE_MINUTES` | 720 | Idle sign-out |
| `SCAN_INTERVAL_MINUTES` | 15 | Inbox scan interval (0 = upload/button only) |
| `SETTLE_SECONDS` | 120 | A hand-copied file must be unchanged this long |
| `DEFAULT_COUNTRY_CODE` | 1 | For numbers written without one |
| `SELF_NUMBERS` | (empty) | Extra own numbers, comma separated |
| `CUTOFF_DAYS` | 730 | Stats cutoff preview |
| `KEEP_RECENT_DAYS` | 30 | Never counted (or, in Phase 2, deleted) |
| `DAV_MAX_GB` | 20 | Largest single upload |
| `LOG_LEVEL` | info | debug, info, warn, error |

All three folders must exist and be writable by uid 1000 / gid 100, or the app exits at start with a clear message.

## Data model (SQLite, `archive.db`, WAL)
- `messages`: one row per unique message, with the original XML attributes kept for restore.
- `parts`: MMS parts, with the media hash or `missing`.
- `media`: hash, size, type and the last verification.
- `conversations`: participant set, title, counts.
- `imports`: one row per file, with counts, status and verification.
- `message_sources`: which import carried which message.
- Also `contacts`, `self_addresses`, `messages_fts` (FTS5, contentless), `sessions`, `settings`, `schema_version`.
- Migrations are forward-only and run in a transaction at start; destructive ones copy the database to `/data/backups/` first.
- To copy the database, stop the container (or copy `.db`, `-wal` and `-shm` together).

## API (session required unless noted)
- No session needed:
  - `GET /healthz` returns `{"status":"ok","version":"0.1.0"}`.
  - `GET /api/auth/state`, `POST /api/auth/setup` (first run only), `POST /api/auth/login`.
- Account: `POST /api/auth/logout`, `POST /api/auth/password`.
- Conversations:
  - `GET /api/conversations?q=`
  - `GET /api/conversations/:id`
  - `GET /api/conversations/:id/messages`, with `?limit=` plus one of `beforeDate&beforeId`, `afterDate&afterId`, `around=<messageId>` or `aroundDate=<ms>`.
- `GET /api/search?q=&conversation=&from=&to=&media=1&limit=&offset=`
- `GET /api/media/:sha256` supports Range requests; add `?download&name=` to download.
- `GET /api/stats`
- Imports and jobs: `GET /api/imports`, `POST /api/imports/scan`, `POST /api/imports/:id/retry`, `POST /api/media/verify`, `GET /api/jobs`.
- Settings: `GET /api/settings`, and `POST /api/settings/dav-password` with `{generate:true}`, `{password}` or `{disable:true}`.
- WebDAV at `/dav/` (Basic auth): OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK.

## Known limits
- Outgoing RCS that Google Messages did not write to the Android message store (a Google bug since about May/June 2026) is not in any backup and cannot be archived.
- End-to-end-encrypted RCS needs a manual backup "as default SMS app"; until then those messages show "not in backup".
- Google Messages' own app storage (RCS media cache) is not reachable.
- HEIC photos are offered as downloads (browsers cannot show them).
- No thumbnails yet: the full image is loaded (lazily).
- Password-protected zip backups are refused, with advice.
- Not installable over plain http (P-4).

## Releases
A release is a commit to `main` that changes the version in `package.json`. The release workflow builds `mybadreligon/message-archive:<version>` and creates the GitHub release and the `v<version>` tag itself. Nobody pushes a tag.
