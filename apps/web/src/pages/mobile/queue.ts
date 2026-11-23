import { csrfToken } from '../../lib/api';

/**
 * Offline scan queue (D09). Scans are kept on the device and sent in order; each carries its own Idempotency-Key, so a send whose reply was lost
 * can be repeated safely — the server answers with the first result instead of picking the box twice. A scan belongs to the user who made it and
 * is only ever sent under that user's sign-in.
 */
export interface QueuedScan {
  id: string; userId: string; shipmentId: string; shipmentNo: string; code: string; at: string;
  state: 'pending' | 'sending' | 'done' | 'error'; message?: string; tries: number;
}
const KEY = 'dhruv.scanQueue';
const listeners = new Set<() => void>();

export function readQueue(): QueuedScan[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as QueuedScan[]; } catch { return []; }
}
function write(q: QueuedScan[]) {
  try { localStorage.setItem(KEY, JSON.stringify(q.slice(-500))); } catch { /* storage full or blocked: the scan stays in memory for this session */ }
  listeners.forEach((l) => l());
}
export function onQueueChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
export function enqueue(s: Pick<QueuedScan, 'userId' | 'shipmentId' | 'shipmentNo' | 'code'>): QueuedScan {
  const item: QueuedScan = { ...s, id: uuid(), at: new Date().toISOString(), state: 'pending', tries: 0 };
  write([...readQueue(), item]);
  return item;
}
export function clearDone() { write(readQueue().filter((x) => x.state !== 'done')); }
export function discard(id: string) { write(readQueue().filter((x) => x.id !== id)); }

let running = false;
/** Sends this user's pending scans, oldest first. Stops at the first network failure (still offline) and leaves the rest pending. */
export async function syncQueue(userId: string): Promise<{ sent: number; failed: number; offline: boolean }> {
  if (running) return { sent: 0, failed: 0, offline: false };
  running = true;
  let sent = 0; let failed = 0; let offline = false;
  try {
    for (const item of readQueue().filter((x) => x.userId === userId && (x.state === 'pending' || x.state === 'sending'))) {
      write(readQueue().map((x) => (x.id === item.id ? { ...x, state: 'sending', tries: x.tries + 1 } : x)));
      let res: Response;
      try {
        res = await fetch(`/api/v1/shipments/${item.shipmentId}/pick`, { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken(), 'idempotency-key': `scan-${item.id}` }, body: JSON.stringify({ boxSerial: item.code }) });
      } catch {
        write(readQueue().map((x) => (x.id === item.id ? { ...x, state: 'pending' } : x)));
        offline = true;
        break;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status >= 500 || res.status === 401) {               // server trouble or signed out: keep it for later
        write(readQueue().map((x) => (x.id === item.id ? { ...x, state: 'pending', message: res.status === 401 ? 'Sign in again to send' : 'Server busy — will retry' } : x)));
        offline = res.status !== 401; break;
      }
      const ok = res.ok;
      const message = ok ? `${body.packs} packs of lot ${body.lotNo} on line ${body.line}` : body?.error?.message ?? `Refused (${res.status})`;
      write(readQueue().map((x) => (x.id === item.id ? { ...x, state: ok ? 'done' : 'error', message } : x)));
      if (ok) sent++; else failed++;
    }
  } finally { running = false; }
  return { sent, failed, offline };
}

/** A label QR holds the verification link; stores scan the serial inside it. */
export const normaliseCode = (raw: string) => (/\/verify\/([^/?#\s]+)/.exec(raw.trim())?.[1] ?? raw.trim());

let audio: AudioContext | null = null;
/** A short beep and a buzz: high for accepted, low for refused — the scanner operator is looking at the box, not the screen. */
export function feedback(ok: boolean) {
  try { navigator.vibrate?.(ok ? 60 : [120, 60, 120]); } catch { /* not supported */ }
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = ok ? 1250 : 300; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  } catch { /* audio blocked until the first tap */ }
}
