import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Db } from '../../db/pool';

/** Storage port. Production uses an S3 adapter (private bucket, SSE-KMS) implementing the same interface (doc 03 AD-11). */
export interface FileStorage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
}

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' }); // never overwrite an existing object
  }
  async get(key: string) {
    const p = this.path(key);
    await stat(p);
    return createReadStream(p);
  }
}

/** Keeps objects in Postgres (sys.file_objects); used where the host has no persistent disk, such as a serverless demo. */
export class DbStorage implements FileStorage {
  constructor(private readonly db: Db) {}
  async put(key: string, data: Buffer, mime: string) {
    await this.db.query(`insert into sys.file_objects (key, data, mime) values ($1, $2, $3)`, [key, data, mime]);
  }
  async get(key: string) {
    const row = (await this.db.query<{ data: Buffer }>(`select data from sys.file_objects where key = $1`, [key])).rows[0];
    if (!row) throw Object.assign(new Error(`No stored object ${key}`), { code: 'ENOENT' });
    return Readable.from([row.data]);
  }
}

/** Detects the real file type from its first bytes; the browser-supplied type is not trusted. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}
