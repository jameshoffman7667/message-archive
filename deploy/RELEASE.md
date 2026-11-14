# Release v0.1.0
Update: later
Image: mybadreligon/message-archive:0.1.0   (built by the release workflow on the push of this version to main; the workflow also creates the v0.1.0 tag and the GitHub release)
Short: Add backup importer, WebDAV upload and viewer        Long: First release (P-1): imports SMS Backup & Restore files from an inbox or WebDAV upload, de-duplicates and verifies every message and attachment, and shows the archive as chats with photos, search and stats. Read-only.
Release commit: see the release report (hash known only after the commit)        Actions run: see the release report
Type: minor (new app, first release)
Port: TBD (new app: assign from the register, 8070-8099; host = container, the app reads PORT)   Exception: none
Public hostname: none (LAN + Tailscale only, James 2026-11-13)        Needs Caddy route: no
New or changed env vars: PORT_HOST, FAST_STORAGE, SLOW_STORAGE, INBOX_PATH, COOKIE_SECURE (false: plain http), SESSION_IDLE_MINUTES, SCAN_INTERVAL_MINUTES, SETTLE_SECONDS, DEFAULT_COUNTRY_CODE, SELF_NUMBERS, CUTOFF_DAYS, KEEP_RECENT_DAYS, DAV_MAX_GB, LOG_LEVEL. No secrets: the sign-in password is created on first run and the WebDAV password is generated in Settings (both stored hashed in the database).
Data: /data = ${FAST_STORAGE}/message-archive (SQLite archive.db, WAL); /files = ${SLOW_STORAGE}/message-archive (media store, a few GB); /inbox = /srv/mergerfs/StoragePool/dump_truck/AppData/message-archive-inbox (agreed with James 2026-11-13; backup drop folder, written by WebDAV uploads and readable over SMB). Create all three, owner 1000:100 (the inbox may stay root:users 2775 like the share, since gid 100 = users, but it must be group-writable). Migration: none (new database, schema 1).
Resources: idle about 60-80 MB RAM, near-zero CPU. Imports stream one message at a time: a 0.7 GB test file (40,300 records, 40 MB videos) imported in 12 s with a 412 MB peak; a ~4 GB first backup should take about 1-2 minutes on one core. Recommended limit: mem_limit 1g (not set in compose).
Healthcheck: GET /healthz on $PORT -> 200 {"status":"ok","version":"0.1.0"} (version = image tag; no login, no private data, no outside services); image HEALTHCHECK and compose both read PORT, require "status":"ok" in the body, 30 s start period
Verify after deploy: 1) docker ps shows message-archive healthy and `curl -s http://127.0.0.1:<port>/healthz` returns the body above; 2) open http://192.168.4.11:<port>/ and create the password (first run), then Settings shows "Phone upload: off"; 3) copy one real SMS Backup & Restore file into the inbox folder (or upload from the phone) and check Imports shows it "verified" and Chats lists real conversations with photos.
PWA: manifest ok, service worker registers, offline page works; layouts checked at 390x844, 768x1024, 1440x900 and 320 px with Playwright/Chromium against demo data; Lighthouse not run. NOT installable as deployed: installing needs HTTPS and the app has no public hostname (LAN/Tailscale over http). Tracked as P-4 (Tailscale HTTPS or a hostname). Cloudflare Access bypass: not needed (no hostname).
Android: none (no public hostname).
AI: none.
Docker build: not run locally (Docker Hub is blocked in the authoring session: 403 on node:20.19-alpine); the first build is the release workflow. Confirm the container starts healthy after deploy.
Rollback: none (first release); remove the stack. Data restore needed: no.
Known issues: Outgoing RCS that Google Messages does not write to the message store (Google bug since about May/June 2026) cannot be archived; encrypted RCS needs a manual "Back up as default SMS app" run; HEIC photos are download-only.
Backup tier: critical (include in Tier 1): the database on FAST_STORAGE and the media under SLOW_STORAGE/docker/message-archive. After Phase 2 this archive is the only copy of old messages. SQLite needs a stop (or .db/-wal/-shm together) during copy. The inbox on dump_truck is SnapRAID only and can be re-created from the phone while it still holds the messages.
Home page: new GUI app; ask James for the group (recommendation: Archives).
