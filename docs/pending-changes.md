# Pending changes: message-archive

Requests are logged here and built only on an explicit build message from James (spec section 1a).

## Pending

### P-2 - Phase 2: one phone app with verified age-based delete
Requested: 2026-11-13 (James: "Phase 2 verified age-based delete"; "I dont want to have to use 2 apps ... roll into a single app")
Type: minor (server: delete-plan API, delete-run log) + new Android project (native Kotlin, not a TWA)        Status: Pending
Notes / questions: The phone app takes over the nightly backup from SMS Backup & Restore (same XML format, same /dav/ upload), adds a dry run (count + bytes per conversation, nothing deleted), and deletes only messages the server confirms by fingerprint and attachment hash, while it is temporarily the default SMS app; then hands the role back to Google Messages. Defaults: cutoff 2 years, last 30 days never touched, excluded conversations. Requires a Tier 1 snapshot newer than the import. Pilot on one small conversation first and measure Google Messages storage before and after. Questions: separate repo (proposed `message-archive-android`)? Distribution through the F-Droid repo needs a native-APK build job (the current template is for TWA apps) and its own signing key made by James. Fingerprint test vectors are locked in test/unit.test.js.

### P-3 - Phase 3: restore selected conversations or dates
Requested: 2026-11-13 (James: "Restore — put selected conversations or date ranges back on the phone, without duplicates")
Type: minor        Status: Pending
Notes / questions: Server exports SMS Backup & Restore-format XML (media embedded) from the stored original attributes; the phone app skips messages already on the phone (fingerprint check) and writes the rest; SMS Backup & Restore can restore the same file as a fallback. Note: SMS Backup & Restore rewrites `tr_id` values starting with `proto:` on restore, so a restored RCS message would get a new fingerprint and come back as a second copy in the archive on the next backup; the phone app's restore must keep the original ids, and the importer may need a rule to recognise restored copies.

### P-4 - Installable over Tailscale HTTPS (or a public hostname)
Requested: 2026-11-13 (noticed while building v0.1.0, not requested: James chose LAN/Tailscale only)
Type: patch (docs/deploy) or minor        Status: Blocked (James to decide)
Notes / questions: A PWA installs only over HTTPS. Options: `tailscale serve` HTTPS on the tailnet name (no app change; COOKIE_SECURE=true), or a public hostname behind Cloudflare Access, which by the spec also needs the security baseline (TOTP) and the Android TWA files. Until then the app works in any browser over http.

### P-5 - Image thumbnails
Requested: 2026-11-13 (noticed while building v0.1.0, not requested)
Type: minor        Status: Pending
Notes / questions: Chats load full-size photos (lazy). Over Tailscale on mobile data, small server-side thumbnails would load faster. Needs an image library (sharp has musl prebuilds) or ffmpeg; adds image size.

### P-6 - Name numbers from a contacts file
Requested: 2026-11-13 (noticed while building v0.1.0, not requested)
Type: minor        Status: Pending
Notes / questions: Names come from `contact_name` in the backups. Numbers never saved as contacts show as numbers; importing a .vcf export would name them.

## Done

### P-1 - Phase 1: backup + viewer (read-only)
Requested: 2026-11-13 (James: "Then build Phase 1")
Type: minor (new app)        Status: Built in v0.1.0
Notes / questions: Phone side agreed as SMS Backup & Restore Pro uploading straight to the app over WebDAV (one phone app). Inbox on dump_truck `AppData/message-archive-inbox`. LAN/Tailscale only, own login; Android: none (no public hostname).
