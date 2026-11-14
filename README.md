# message-archive

Self-hosted archive and viewer for Android text messages. SMS Backup & Restore on the phone uploads its nightly backup over WebDAV; this app imports it, de-duplicates and verifies every message and attachment, and shows the archive like a messaging app with search. Phase 1 of a three-phase plan (backup + viewer, verified age-based delete, restore): see `docs/architecture.md`, `docs/functional-spec.md` and `docs/pending-changes.md`.

## Run locally
```
npm ci
mkdir -p /tmp/ma/{data,files,inbox} && node scripts/make-demo.js /tmp/ma/inbox/sms-demo.xml
PORT=8080 DATA_DIR=/tmp/ma/data FILES_DIR=/tmp/ma/files INBOX_DIR=/tmp/ma/inbox SETTLE_SECONDS=0 npm start
```
Open http://localhost:8080, create the password, and the demo backup is imported within about 10 seconds.

## Test
`npm test` (node --test, no network needed).

## Releases
A release is a commit pushed to `main` that changes `version` in `package.json` (with its `CHANGELOG.md` entry and `deploy/` files). The GitHub Actions workflow builds `mybadreligon/message-archive:<version>`, then creates the GitHub release and the `v<version>` tag itself. Nobody pushes tags. Deployment is done by Claude Code on the server from `deploy/RELEASE.md` and `deploy/compose.yaml`.
