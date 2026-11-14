import crypto from 'node:crypto';

// Placeholder SMS Backup & Restore writes for the phone owner's own number.
export const SELF_TOKEN = 'insert-address-token';

// Normalize a phone number or address so the same person always gets one key.
// NANP (country code 1) is the default: 10-digit and 11-digit "1..." numbers become +1XXXXXXXXXX.
export function normAddr(raw, cc = '1') {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'null') return '';
  if (s === SELF_TOKEN) return SELF_TOKEN;
  if (s.includes('@')) return s.toLowerCase();
  const digits = s.replace(/\D/g, '');
  if (!digits || /[a-z]/i.test(s)) return s.toLowerCase(); // alphanumeric sender ids (banks, carriers)
  if (s.startsWith('+')) return '+' + digits;
  if (digits.startsWith('00') && digits.length > 8) return '+' + digits.slice(2);
  if (cc === '1') {
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  } else if (digits.length > 9 && digits.startsWith(cc)) {
    return '+' + digits;
  }
  return digits; // short codes and anything else stay as plain digits
}

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Fingerprint rules (Phase 2's phone app must compute the same value from the provider):
// SMS: kind, date (ms), type, normalized address, body.
// MMS: kind, date (ms; provider stores seconds, so value = seconds*1000), msg_box,
//      sorted "normalizedAddress|type" list, and either the m_id/tr_id pair (when present)
//      or the joined text parts. Media is never part of it, so a later backup that carries
//      the media of a message first seen without it upgrades that message.
export function smsFingerprint(a, cc) {
  return sha(['sms', String(a.date ?? ''), String(a.type ?? ''), normAddr(a.address, cc), a.body ?? '']);
}

export function mmsFingerprint(a, addrs, text, cc) {
  const list = addrs.map((x) => `${normAddr(x.address, cc)}|${x.type ?? ''}`).sort();
  const mid = clean(a.m_id), tid = clean(a.tr_id);
  const tail = mid || tid ? ['ids', mid, tid] : ['text', text ?? ''];
  return sha(['mms', String(a.date ?? ''), String(a.msg_box ?? ''), list, ...tail]);
}

function clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s === 'null' ? '' : s;
}
