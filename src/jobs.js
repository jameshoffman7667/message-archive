import { scanInbox, importFile } from './importer.js';
import { verifyAllMedia } from './media.js';

// One background job at a time (the VM is shared). Scans are coalesced.
export function createJobs(ctx) {
  const { db, cfg, log } = ctx;
  const queue = [];
  const ready = new Set();
  let running = null;
  let stopping = false;
  let idle = Promise.resolve();
  const last = {};

  function enqueue(name, fn) {
    if (stopping) return false;
    if (queue.some((j) => j.name === name) && name === 'scan') return true;
    queue.push({ name, fn });
    if (!running) idle = pump();
    return true;
  }

  async function pump() {
    while (queue.length && !stopping) {
      const job = queue.shift();
      running = { name: job.name, started: Date.now(), progress: null };
      try {
        const result = await job.fn((p) => { if (running) running.progress = p; });
        last[job.name] = { ok: true, finished: Date.now(), result };
      } catch (e) {
        last[job.name] = { ok: false, finished: Date.now(), error: e.message };
        log.error('job failed', { job: job.name, err: e.message });
      }
      running = null;
    }
  }

  const shouldStop = () => stopping;
  return {
    scan({ force = false } = {}) {
      return enqueue('scan', async () => {
        const res = await scanInbox(ctx, { shouldStop, ready, force });
        for (const r of res) ready.delete(r.file_path);
        return { imports: res.length, verified: res.filter((r) => r.status === 'verified').length, failed: res.filter((r) => r.status === 'failed').length };
      });
    },
    retry(importRow) {
      return enqueue(`retry-${importRow.id}`, async () => {
        const r = await importFile(ctx, importRow.file_path, { shouldStop, source: importRow.source, force: true });
        return { id: r.id, status: r.status };
      });
    },
    verifyMedia() {
      return enqueue('verify-media', async (progress) => {
        const out = await verifyAllMedia(db, cfg.filesDir, { shouldStop, onProgress: (i, n) => progress(`${i}/${n}`) });
        log.info('media verify finished', { total: out.total, ok: out.ok, missing: out.missing, mismatched: out.mismatched });
        return out;
      });
    },
    uploaded(file) { ready.add(file); this.scan(); },
    status() { return { running, queued: queue.map((j) => j.name), last }; },
    async stop() { stopping = true; queue.length = 0; await idle; },
    idle: () => idle,
  };
}
