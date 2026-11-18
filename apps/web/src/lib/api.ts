export interface ApiErrorBody { code: string; message: string; details?: unknown; traceId?: string }

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message); }
  get code() { return this.body.code; }
  /** field -> message, for mapping server validation errors onto form fields */
  get fieldErrors(): Record<string, string> {
    const d = this.body.details;
    if (!Array.isArray(d)) return {};
    return Object.fromEntries(d.filter((x) => x && x.field).map((x: { field: string; message: string }) => [x.field, x.message]));
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )dcsrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : method !== 'GET' ? '{}' : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const body: ApiErrorBody = json?.error ?? { code: 'HTTP_' + res.status, message: 'Request failed.' };
    if (res.status === 401 && body.code === 'AUTH_REQUIRED' && !location.pathname.startsWith('/login')) {
      location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
    }
    throw new ApiError(res.status, body);
  }
  return json as T;
}

export interface Page<T> { data: T[]; total: number }

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Raw-body file upload (PDF/PNG/JPEG); metadata goes in the query string. */
export async function uploadFile<T = unknown>(path: string, file: File, meta: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/v1${path}${qs({ ...meta, fileName: file.name })}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-csrf-token': csrfToken() },
    body: file,
  });
  const json = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? { code: 'HTTP_' + res.status, message: 'Upload failed.' });
  return json as T;
}
