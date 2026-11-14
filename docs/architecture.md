# Message Archive: architecture and phased plan

Written 2026-11-13. Phone: Samsung Galaxy S23, Google Messages as the default SMS/RCS app. Server: James's home server (Proxmox VM 101, OpenMediaVault, Docker; see `docs/home-server-reference.md` in `homelab`. The request said Unraid; the server reference is authoritative and describes OMV, so this design follows it).

## 1. What is and is not reachable on the phone

| Data | Where it lives | Reachable by a non-default app? | Notes |
| --- | --- | --- | --- |
| SMS | Android telephony provider (`content://sms`) | Yes, with `READ_SMS` | Full fidelity. |
| MMS incl. photos, video, audio, group chats | Telephony provider (`content://mms`, parts on disk inside the provider) | Yes, with `READ_SMS` | This is the ~3.0 GB / 4,860 attachments you measured. |
| RCS (non-encrypted) | Google Messages writes a copy into the telephony provider as MMS rows | Yes | This is why you have ~45,800 MMS records. Group RCS chats use `...@rcs.google.com` addresses; real participants are in the `<addr>` list. |
| RCS end-to-end encrypted | Provider rows flagged `restricted` | Only the default SMS app | Scheduled backups miss them. SMS Backup & Restore has "Back up as default SMS app" for manual runs (becomes default briefly). |
| Outgoing RCS since about May/June 2026 | Not written to the provider at all (Google Messages bug, per SyncTech) | No one | Only Google's own cloud backup has them. Nothing a third-party tool can do. |
| Google Messages private storage (~3.2 GB app data) | `/data/data/com.google.android.apps.messaging` | No (needs root) | Its own copies/caches of RCS media. Whether deleting the provider copy also frees this is unknown; Phase 2 measures it on one test conversation before any bulk delete. |
| Anything via `adb shell content query` | | No | The shell user lacks `READ_SMS` (Permission Denial). adb is not a viable export path without root. |

Consequences:
- The archive can capture all SMS/MMS and most RCS, with media.
- Space that Phase 2 can reliably free: the ~1.9 GB of provider attachments older than 2 years. The 3.2 GB in Google Messages is "maybe", to be measured.
- Deleting requires the default-SMS role. Third-party apps cannot do RCS, so the role must go back to Google Messages right after.

## 2. Options evaluated (phone side)

| Option | Backup | Delete by age | Restore | Effort / risk |
| --- | --- | --- | --- | --- |
| **A. SMS Backup & Restore (SyncTech) + FolderSync** | Mature, scheduled, incremental, MMS media, contact names, handles restricted RCS when run as default | No (only "delete all") | Yes, with duplicate check, handles the default-app switch itself | Lowest. XML format is documented and stable ("attributes are never removed or renamed"). |
| B. Own Android app for everything | Must re-implement MMS/RCS edge cases SyncTech has fixed over years | Yes | Must re-implement restore and Google Messages resync quirks | High; most bugs would be in the parts that already work in A. |
| C. adb export | Blocked by permissions | Blocked | Blocked | Not viable. |
| D. Google Messages / Google One backup | Cloud only, not readable, no viewer | Manual per conversation (goes to Messages Trash) | Whole-phone restore only | Keep it on as a safety net; not a solution. |

**Recommendation (agreed 2026-11-13): one app on the phone at every stage.**
- Phase 1: SMS Backup & Restore Pro alone. It uploads each scheduled backup straight to the server over WebDAV (an upload endpoint built into `message-archive`), so no FolderSync is needed. Set and forget.
- Phase 2: our own companion app replaces it. It writes the same XML format to the same endpoint, and adds the verified delete and the restore. SMS Backup & Restore can then be uninstalled; the server does not change.

## 3. Recommended architecture

```
Phone                                                    Server (Docker, VM 101)
-----                                                    -----------------------
SMS Backup & Restore Pro (Phase 1)                       message-archive container
  daily scheduled incremental backup                       WebDAV upload endpoint /dav/ (own password)
  occasional manual "as default SMS app"                    -> /inbox (dump_truck/AppData/message-archive-inbox)
  WebDAV upload ──────── LAN / Tailscale ──────────────>   importer (scans /inbox; manual SMB drops also work)
                                                             stream-parse XML (multi-GB OK)
                                                             dedupe by message fingerprint
                                                             media -> content-addressed files (sha256)
                                                             SQLite + FTS5 index, original attributes kept
                                                             verification report per import
                                                           viewer PWA (conversations, bubbles, media, search)
Phase 2+: companion app (backup, delete) <──API/WebDAV──   delete plan + fingerprint check
Phase 3: companion app restore           <──XML file───    export of selected conversations / dates
```

### Server data model
- `messages`: one row per unique message. Fingerprint = SHA-256 of kind, date (ms), box (received/sent), normalized participants, the MMS ids (`m_id`/`tr_id`) and the text. Media is not in the fingerprint, so a later backup that carries media for a message first seen without it (restricted RCS, media backup off) fills it in instead of creating a duplicate. `copies` counts genuine identical twins in one backup so a later delete never removes more than the archive holds.
- All original XML attributes (message, parts, addresses) are stored, so Phase 3 can write back a faithful SMS Backup & Restore file.
- `media`: content-addressed files on bulk storage (`/files/media/ab/cd/<sha256>`), written to a temp name, hashed, then renamed. Identical photos sent twice are stored once.
- `imports`: one row per backup file (file hash, counts, status). Re-importing the same file is a no-op; full, incremental and archive-mode files can be mixed freely.
- Conversations are derived from participant sets (your own numbers are learned from sent messages), not phone thread ids, so they survive phone changes.

### Verification (the gate for Phase 2)
Per import: records parsed must equal the file's `count`; every message in the file must be found in the database afterwards; every media part with data must have a file on disk whose size and SHA-256 match. Status is `verified` only if all hold. A separate "Verify media" job re-hashes every stored file. Parts that are media types but have no data (restricted RCS) are counted and shown, never silently passed.

### Storage and backup tier
- `/data` (fast SSD): SQLite database (small, tens of MB).
- `/files` (pool, `docker/message-archive`): media, a few GB. That folder is under the pool's `docker/` tree, which Tier 1 backs up.
- After Phase 2 this archive is the only copy of old messages, so it is backup tier **critical**. Phase 2 also requires a Tier 1 snapshot newer than the import before it will plan deletions.

### Access
Single user, own login (scrypt-hashed password, server-side sessions, rate-limited sign-in, CSRF checks). LAN and Tailscale only, as requested. Note: installing a PWA needs HTTPS, so plain `http://192.168.4.11:<port>` works in a browser but does not install; see the open questions.

## 4. Phased plan

### Phase 1 (this release): backup + viewer, read-only, zero risk to the phone
Phone setup (one time, one app):
1. Install SMS Backup & Restore Pro. Backup settings: Messages on, Call logs off, include MMS media on, add contact names on, back up text-only MMS on, incremental backups on, compression off or zip without a password.
2. Backup location: WebDAV, URL `http://<server>:<port>/dav/` (LAN or Tailscale address), user `archive`, the WebDAV password set in the viewer (Settings). Schedule daily at night.
3. First run: a manual full backup with "Back up as default SMS app" (captures restricted RCS), then set Google Messages as default again. Repeat that manual run every month or two.
Server: importer, verification, viewer, search, stats (including a read-only "older than cutoff" preview).
Exit criteria: two weeks of nightly imports all `verified`; spot-check 10 conversations against the phone; media verify job clean.

### Phase 2: verified age-based delete
Companion app (Kotlin, native, sideloaded or from your F-Droid repo). It becomes the only phone app: it takes over the scheduled backup (same XML format, same `/dav/` upload, so the server is unchanged) and adds:
1. Dry run (no default role needed): reads provider rows older than the cutoff (default 2 years), skips the last N days (default 30) and excluded conversations, computes the same fingerprint as the server, hashes each attachment, and asks the server which are archived and verified. Shows per conversation: messages, attachments, bytes freed; lists anything not archived (those are never deleted).
2. Delete: requests the default-SMS role (system dialog), deletes only rows the server confirmed in this session (by provider `_id`, re-checked just before delete), in small batches, logs every id, then opens the system dialog to give the role back to Google Messages. Includes a minimal SMS receiver so an SMS arriving during the few minutes it is default is stored, not lost. RCS that arrives in that window is delivered after Google Messages is default again.
3. Server records each delete run; the viewer marks those messages "deleted from phone".
Pilot: one small test conversation first; measure Messages app storage before and after.

### Phase 3: restore
Server exports an SMS Backup & Restore-format XML (media embedded) for selected conversations or a date range. The companion app downloads it, skips messages already on the phone (same fingerprint check), and writes the rest while it is temporarily default, then hands the role back. The file also works with SMS Backup & Restore as a fallback (its duplicate check is on by default). Restored RCS come back as SMS/MMS, which is expected.

## 5. Risks and mitigations
- Google Messages changes how it stores RCS (it has twice in 2026): the importer reports restricted / missing-media counts on every import, so a change shows up as a number, not as silent loss.
- Fingerprint drift between backups: the fingerprint uses only fields the provider stores; tests lock the algorithm; Phase 2 never deletes anything that does not match exactly.
- Very large files (several GB of base64): streaming parser, one message in memory at a time.
- Losing the server copy after deletes: critical backup tier, Tier 1 snapshot check before planning deletes.
