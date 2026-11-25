import { ArrowLeft, Barcode, Camera, CheckCircle, CloudArrowUp, MagnifyingGlass, Package, SignOut, Truck, WarningCircle, WifiSlash, X } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';
import { clearDone, discard, enqueue, feedback, normaliseCode, onQueueChange, readQueue, syncQueue, type QueuedScan } from './queue';

/**
 * Mobile scanner (D09: PWA + keyboard-wedge scanners; device camera where the browser can read barcodes).
 * Full-screen, large targets, works with gloves. Box scans for a shipment are queued on the device and sent when the network is there.
 */
function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => { const a = () => setOn(true); const b = () => setOn(false); addEventListener('online', a); addEventListener('offline', b); return () => { removeEventListener('online', a); removeEventListener('offline', b); }; }, []);
  return on;
}
function useQueue() {
  const [q, setQ] = useState<QueuedScan[]>(readQueue);
  useEffect(() => onQueueChange(() => setQ(readQueue())), []);
  return q;
}
/** Sends pending scans whenever the device comes online, and every 20 seconds while any are waiting. */
function useAutoSync() {
  const { me } = useAuth();
  const online = useOnline();
  const q = useQueue();
  const pending = q.filter((x) => me && x.userId === me.user.id && x.state === 'pending').length;
  useEffect(() => {
    if (!me || !online || !pending) return;
    void syncQueue(me.user.id);
    const t = setInterval(() => void syncQueue(me.user.id), 20_000);
    return () => clearInterval(t);
  }, [me, online, pending]);
  return { online, pending };
}

function Shell({ title, back, children }: { title: string; back?: string; children: ReactNode }) {
  const { me, offline } = useAuth();
  const { online, pending } = useAutoSync();
  const nav = useNavigate();
  const out = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* offline */ } try { localStorage.removeItem('dhruv.me'); } catch { /* ignore */ } location.assign('/login?next=/m'); };
  return (
    <div className="min-h-screen bg-canvas pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-primary px-4 py-3 text-white shadow">
        {back ? <button aria-label="Back" className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/15" onClick={() => nav(back)}><ArrowLeft size={24} /></button> : <Barcode size={28} aria-hidden />}
        <div className="min-w-0 flex-1"><h1 className="truncate text-[18px] font-bold">{title}</h1><p className="truncate text-[12px] opacity-80">{me?.user.fullName}</p></div>
        <Link to="/m/queue" className="relative grid h-11 w-11 place-items-center rounded-full hover:bg-white/15" aria-label={`${pending} scans waiting to send`}>
          <CloudArrowUp size={24} />{pending > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-warning-text px-1 text-[11px] font-bold">{pending}</span>}</Link>
        <button aria-label="Sign out" className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/15" onClick={out}><SignOut size={22} /></button>
      </header>
      {(!online || offline) && <p className="flex items-center gap-2 bg-warning-bg px-4 py-2 text-[14px] font-semibold text-warning-text"><WifiSlash size={18} />Offline — scans are saved on this device and sent when the network is back.</p>}
      <main className="mx-auto max-w-xl p-4">{children}</main>
    </div>
  );
}

/** Keyboard-wedge scanners type the code and press Enter; the camera button reads codes where the browser supports it. */
function ScanBox({ onScan, label, busy }: { onScan: (code: string) => void; label: string; busy?: boolean }) {
  const [v, setV] = useState('');
  const [cam, setCam] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const hasCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => { ref.current?.focus(); }, [busy]);
  const submit = (code: string) => { const c = normaliseCode(code); if (c) { onScan(c); setV(''); } ref.current?.focus(); };
  return (
    <div className="card p-4">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(v); }}>
        <input ref={ref} aria-label={label} inputMode="text" autoCapitalize="characters" autoComplete="off" placeholder={label} value={v} onChange={(e) => setV(e.target.value)}
          className="h-14 min-w-0 flex-1 rounded-lg border-2 border-primary px-4 text-[18px] font-semibold tracking-wide outline-none focus:ring-4 focus:ring-primary/20" />
        <button type="submit" className="h-14 rounded-lg bg-primary px-5 text-[16px] font-bold text-white disabled:opacity-50" disabled={!v.trim() || busy}>Go</button>
      </form>
      {hasCamera && <button className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-line bg-white font-semibold" onClick={() => setCam(true)}><Camera size={20} />Scan with camera</button>}
      {cam && <CameraScanner onClose={() => setCam(false)} onCode={(c) => { setCam(false); submit(c); }} />}
    </div>
  );
}

interface Detector { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> }
function CameraScanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null; let timer = 0; let stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        const Det = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        const det = new Det({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'] });
        const tick = async () => {
          if (stop || !video.current) return;
          try { const r = await det.detect(video.current); if (r[0]?.rawValue) { onCode(r[0].rawValue); return; } } catch { /* frame not ready */ }
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      } catch { setErr('The camera could not be opened. Allow camera access, or use the scanner gun.'); }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-3 text-white"><span className="font-semibold">Point at the box label</span><button aria-label="Close camera" className="grid h-11 w-11 place-items-center" onClick={onClose}><X size={26} /></button></div>
      {err ? <p className="m-4 rounded-lg bg-white p-4 text-danger-text">{err}</p> : <video ref={video} className="h-full w-full object-cover" playsInline muted />}
    </div>
  );
}

// ---------------------------------------------------------------- home
export function MobileHomePage() {
  const { can } = useAuth();
  const tiles = [
    can('logistics.shipment:pick') && { to: '/m/pick', label: 'Pick for dispatch', text: 'Scan boxes onto a shipment', icon: Truck },
    ['inv.stock:view', 'logistics.shipment:view', 'mfg.packing:view'].some(can) && { to: '/m/lookup', label: 'Look up', text: 'Scan a box or lot to see its status and stock', icon: MagnifyingGlass },
    { to: '/m/queue', label: 'Scans to send', text: 'What is waiting on this device', icon: CloudArrowUp },
  ].filter(Boolean) as { to: string; label: string; text: string; icon: typeof Truck }[];
  return (
    <Shell title="Dhruv Scanner">
      <div className="grid gap-3">{tiles.map((t) => (
        <Link key={t.to} to={t.to} className="card flex items-center gap-4 p-5 active:scale-[0.99]"><span className="grid h-14 w-14 place-items-center rounded-xl bg-primary-tint text-primary"><t.icon size={30} weight="duotone" /></span>
          <span><span className="block text-[18px] font-bold">{t.label}</span><span className="text-[14px] text-ink-2">{t.text}</span></span></Link>))}</div>
      <p className="mt-6 text-center text-[13px] text-ink-2">Add this page to the home screen to use it like an app. <Link className="text-primary" to="/">Full portal</Link></p>
    </Shell>
  );
}

// ---------------------------------------------------------------- picking
interface Ship { id: string; docNo: string; partyName: string; warehouseCode: string; plannedDate: string; status: string }
interface ShipDetail extends Ship { lines: { id: string; lineNo: number; description: string; packLabel: string; plannedPacks: string; pickedPacks: string; unitsPerBox: number }[] }
const SHIP_CACHE = 'dhruv.m.shipments';

export function MobilePickListPage() {
  const q = useQuery({ queryKey: ['m-shipments'], queryFn: async () => {
    try {
      const r = await api<{ data: Ship[] }>('/shipments');
      const open = r.data.filter((s) => ['Planned', 'Picked'].includes(s.status));
      try { localStorage.setItem(SHIP_CACHE, JSON.stringify(open)); } catch { /* ignore */ }
      return { data: open, cached: false };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return { data: JSON.parse(localStorage.getItem(SHIP_CACHE) ?? '[]') as Ship[], cached: true };
    }
  } });
  return (
    <Shell title="Pick for dispatch" back="/m">
      {q.data?.cached && <p className="mb-3 text-[13px] text-warning-text">Shown from this device's last list.</p>}
      {q.isLoading ? <p className="text-ink-2">Loading…</p> : !q.data?.data.length ? <p className="card p-5 text-ink-2">No shipments are waiting to be picked.</p> : (
        <div className="grid gap-3">{q.data.data.map((s) => (
          <Link key={s.id} to={`/m/pick/${s.id}`} className="card p-4 active:scale-[0.99]">
            <div className="flex items-center justify-between"><span className="text-[17px] font-bold num">{s.docNo}</span><span className="rounded-full bg-primary-tint px-3 py-1 text-[12px] font-semibold text-primary">{s.status}</span></div>
            <p className="mt-1 text-[15px]">{s.partyName}</p><p className="text-[13px] text-ink-2">From {s.warehouseCode} · planned {fmtDate(s.plannedDate)}</p></Link>))}</div>
      )}
    </Shell>
  );
}

export function MobilePickPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const online = useOnline();
  const queue = useQueue();
  const key = `dhruv.m.shipment.${id}`;
  const q = useQuery({ queryKey: ['m-shipment', id], queryFn: async () => {
    try { const d = await api<ShipDetail>(`/shipments/${id}`); try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* ignore */ } return d; }
    catch (e) { if (e instanceof ApiError) throw e; const c = localStorage.getItem(key); if (c) return JSON.parse(c) as ShipDetail; throw e; }
  } });
  const [last, setLast] = useState<{ ok: boolean | null; text: string } | null>(null);
  const mine = queue.filter((x) => x.shipmentId === id);
  const s = q.data;
  const scan = useCallback(async (code: string) => {
    if (!me || !s) return;
    if (mine.some((x) => x.code.toUpperCase() === code.toUpperCase() && x.state !== 'error')) { feedback(false); setLast({ ok: false, text: `${code} is already scanned on this shipment.` }); return; }
    const item = enqueue({ userId: me.user.id, shipmentId: s.id, shipmentNo: s.docNo, code });
    if (!navigator.onLine) { feedback(true); setLast({ ok: null, text: `${code} saved — will be sent when online.` }); return; }
    await syncQueue(me.user.id);
    const done = readQueue().find((x) => x.id === item.id);
    if (done?.state === 'done') { feedback(true); setLast({ ok: true, text: `${code}: ${done.message}` }); void q.refetch(); }
    else if (done?.state === 'error') { feedback(false); setLast({ ok: false, text: `${code}: ${done.message}` }); }
    else { feedback(true); setLast({ ok: null, text: `${code} saved — will be sent when the network is back.` }); }
  }, [me, s, mine, q]);
  if (!s) return <Shell title="Shipment" back="/m/pick"><p className="text-ink-2">{q.isLoading ? 'Loading…' : 'This shipment is not available offline yet. Open it once while online.'}</p></Shell>;
  const queued = mine.filter((x) => x.state === 'pending' || x.state === 'sending').length;
  return (
    <Shell title={s.docNo} back="/m/pick">
      <p className="mb-3 text-[15px]"><b>{s.partyName}</b> · from {s.warehouseCode}</p>
      <ScanBox label="Scan box label" onScan={scan} />
      {last && <div role="status" className={`mt-3 flex items-start gap-3 rounded-lg p-4 text-[16px] font-semibold ${last.ok === true ? 'bg-success-bg text-success-text' : last.ok === false ? 'bg-danger-bg text-danger-text' : 'bg-warning-bg text-warning-text'}`}>
        {last.ok === false ? <WarningCircle size={26} className="shrink-0" /> : <CheckCircle size={26} className="shrink-0" />}<span>{last.text}</span></div>}
      <div className="mt-4 grid gap-3">{s.lines.map((l) => {
        const planned = Number(l.plannedPacks); const picked = Number(l.pickedPacks);
        return (
          <div key={l.id} className="card p-4">
            <p className="font-semibold">{l.description}</p><p className="text-[13px] text-ink-2">{l.packLabel} · {l.unitsPerBox} per box</p>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-line"><div className={`h-full ${picked >= planned ? 'bg-success-text' : 'bg-primary'}`} style={{ width: `${Math.min(100, (picked / planned) * 100)}%` }} /></div>
            <p className="mt-1 text-[15px] num"><b>{fmtNum(picked)}</b> of {fmtNum(planned)} packs{online ? '' : ' (at last sync)'}</p>
          </div>);
      })}</div>
      {queued > 0 && <p className="mt-3 text-[14px] text-warning-text">{queued} scan{queued === 1 ? '' : 's'} waiting to send.</p>}
      {mine.length > 0 && <div className="card mt-4 p-4"><p className="mb-2 font-semibold">Scanned here</p>
        <ul className="space-y-1 text-[14px]">{[...mine].reverse().slice(0, 20).map((x) => <li key={x.id} className="flex justify-between gap-2"><span className="num">{x.code}</span>
          <span className={x.state === 'done' ? 'text-success-text' : x.state === 'error' ? 'text-danger-text' : 'text-warning-text'}>{x.state === 'done' ? 'Picked' : x.state === 'error' ? 'Refused' : 'Waiting'}</span></li>)}</ul></div>}
    </Shell>
  );
}

// ---------------------------------------------------------------- lookup
interface Lookup { kind: 'box' | 'lot'; code: string; verdict: string; stock: { warehouse: string; bucket: string; qty: string }[];
  box?: { serial: string; units: number; status: string; packSize: string; packUom: string; container: string; lotNo: string; qcStatus: string; mfgDate: string | null; expiryDate: string | null; itemCode: string; itemName: string; packingRun: string; shipmentNo: string | null; packedAt: string };
  lot?: { lotNo: string; qcStatus: string; mfgDate: string | null; expiryDate: string | null; vendorLotNo: string | null; itemCode: string; itemName: string; uom: string; boxesReady: number } }
export function MobileLookupPage() {
  const [res, setRes] = useState<Lookup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const look = async (code: string) => {
    setBusy(true); setErr(null); setRes(null);
    try { const r = await api<Lookup>(`/stock/scan/${encodeURIComponent(code)}`); setRes(r); feedback(!/do not|not released|Rejected|Hold/i.test(r.verdict)); }
    catch (e) { feedback(false); setErr(e instanceof ApiError ? e.message : 'No network — look-up needs a connection.'); }
    finally { setBusy(false); }
  };
  const good = res && !/do not|not released|Rejected|Hold|Quarantine/i.test(res.verdict);
  const row = (k: string, v: ReactNode) => <div className="flex justify-between gap-3 border-b border-line py-2 last:border-0"><span className="text-ink-2">{k}</span><span className="text-right font-semibold">{v}</span></div>;
  return (
    <Shell title="Look up" back="/m">
      <ScanBox label="Scan box or lot" onScan={look} busy={busy} />
      {!online && <p className="mt-3 text-[14px] text-warning-text">Look-up needs the network.</p>}
      {err && <p role="alert" className="mt-3 rounded-lg bg-danger-bg p-4 font-semibold text-danger-text">{err}</p>}
      {res && (
        <div className="card mt-3 p-4">
          <p className={`mb-3 rounded-lg p-3 text-[17px] font-bold ${good ? 'bg-success-bg text-success-text' : 'bg-warning-bg text-warning-text'}`}>{res.verdict}</p>
          {res.box && <>{row('Box', <span className="num">{res.box.serial}</span>)}{row('Product', `${res.box.itemCode} — ${res.box.itemName}`)}{row('Contents', `${res.box.units} × ${fmtNum(res.box.packSize)} ${res.box.packUom} ${res.box.container ?? ''}`)}
            {row('Lot', res.box.lotNo)}{row('QC status', res.box.qcStatus)}{row('Expiry', fmtDate(res.box.expiryDate))}{row('Packed', `${res.box.packingRun}, ${fmtDateTime(res.box.packedAt)}`)}{res.box.shipmentNo && row('Shipment', res.box.shipmentNo)}</>}
          {res.lot && <>{row('Lot', res.lot.lotNo)}{row('Product', `${res.lot.itemCode} — ${res.lot.itemName}`)}{row('QC status', res.lot.qcStatus)}{row('Expiry', fmtDate(res.lot.expiryDate))}
            {res.lot.vendorLotNo && row('Supplier lot', res.lot.vendorLotNo)}{row('Boxes ready to ship', res.lot.boxesReady)}</>}
          {res.stock.length > 0 && <><p className="mb-1 mt-3 font-semibold">Stock of the lot</p>{res.stock.map((x) => <div key={`${x.warehouse}${x.bucket}`}>{row(`${x.warehouse} · ${x.bucket.toLowerCase()}`, fmtNum(x.qty))}</div>)}</>}
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------- queue
export function MobileQueuePage() {
  const { me } = useAuth();
  const q = useQueue();
  const online = useOnline();
  const [msg, setMsg] = useState<string | null>(null);
  const sendNow = async () => { if (!me) return; const r = await syncQueue(me.user.id); setMsg(r.offline ? 'Still offline — will retry.' : `Sent ${r.sent}, refused ${r.failed}.`); };
  const others = q.filter((x) => me && x.userId !== me.user.id && x.state !== 'done').length;
  return (
    <Shell title="Scans to send" back="/m">
      <div className="mb-3 flex gap-2">
        <button className="h-12 flex-1 rounded-lg bg-primary font-bold text-white disabled:opacity-50" disabled={!online} onClick={sendNow}>Send now</button>
        <button className="h-12 rounded-lg border border-line bg-white px-4 font-semibold" onClick={clearDone}>Clear sent</button>
      </div>
      {msg && <p className="mb-3 text-[14px]">{msg}</p>}
      {others > 0 && <p className="mb-3 rounded-lg bg-warning-bg p-3 text-[14px] text-warning-text">{others} scan{others === 1 ? '' : 's'} made by another user on this device wait for that user to sign in.</p>}
      {!q.length ? <p className="card p-5 text-ink-2">Nothing on this device.</p> : (
        <ul className="grid gap-2">{[...q].reverse().map((x) => (
          <li key={x.id} className="card flex items-start justify-between gap-3 p-3">
            <div className="min-w-0"><p className="font-semibold num"><Package size={16} className="mr-1 inline" />{x.code}</p><p className="text-[13px] text-ink-2">{x.shipmentNo} · {fmtDateTime(x.at)}</p>
              {x.message && <p className={`text-[13px] ${x.state === 'error' ? 'text-danger-text' : 'text-ink-2'}`}>{x.message}</p>}</div>
            <div className="flex shrink-0 flex-col items-end gap-1"><span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${x.state === 'done' ? 'bg-success-bg text-success-text' : x.state === 'error' ? 'bg-danger-bg text-danger-text' : 'bg-warning-bg text-warning-text'}`}>
              {x.state === 'done' ? 'Sent' : x.state === 'error' ? 'Refused' : x.state === 'sending' ? 'Sending' : 'Waiting'}</span>
              {x.state === 'error' && <button className="text-[12px] text-primary" onClick={() => discard(x.id)}>Remove</button>}</div>
          </li>))}</ul>
      )}
    </Shell>
  );
}
