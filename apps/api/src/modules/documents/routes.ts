import { createHash, createHmac, randomUUID } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { documentMetaSchema } from '@dhruv/contracts';
import type { Config } from '../../config';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { safeEqual } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { actorOf, can, inLegalEntityScope, territoryScope } from '../../middleware/context';
import { sniffMime, type FileStorage } from './storage';

/** Which records can hold documents, and which permissions govern them. */
interface EntityRule {
  table: string; view: string; edit: string[]; scope: 'id' | 'legal_entity_id' | 'territory' | null;
  /** permission needed to open documents whose type is marked sensitive (X26) */
  sensitivePerm?: string;
}
const ENTITIES: Record<string, EntityRule> = {
  'org.legal_entity': { table: 'org.legal_entities', view: 'org.legal_entity:view', edit: ['org.legal_entity:edit_draft'], scope: 'id' },
  'org.plant': { table: 'org.plants', view: 'org.plant:view', edit: ['org.plant:edit_draft'], scope: 'legal_entity_id' },
  'org.warehouse': { table: 'org.warehouses', view: 'org.warehouse:view', edit: ['org.warehouse:edit_draft'], scope: 'legal_entity_id' },
  'mdm.item': { table: 'mdm.items', view: 'mdm.item:view', edit: ['mdm.item:edit_draft'], scope: null },
  'qc.inspection': { table: 'qc.inspections', view: 'qc.inspection:view', edit: ['qc.inspection:record'], scope: null },
  'purchase.goods_receipt': { table: 'purchase.goods_receipts', view: 'purchase.grn:view', edit: ['purchase.grn:create'], scope: null },
  'mdm.party': { table: 'mdm.parties', view: 'mdm.dealer:view', edit: ['mdm.dealer:edit_draft'], scope: 'territory', sensitivePerm: 'mdm.dealer:view_sensitive' },
};
/** A party's documents follow the role it is onboarded in: dealers are sales-owned and territory-scoped; vendors are purchase-owned. */
const VENDOR_PARTY: EntityRule = { table: 'mdm.parties', view: 'mdm.vendor:view', edit: ['mdm.vendor:edit_draft'], scope: null, sensitivePerm: 'mdm.vendor:view_sensitive' };
async function ruleFor(dbx: Db | Tx, entityType: string, entityId: string): Promise<EntityRule | undefined> {
  if (entityType === 'mdm.party' && (await dbx.query(`select 1 from mdm.vendor_profiles where party_id = $1`, [entityId])).rowCount) return VENDOR_PARTY;
  return ENTITIES[entityType];
}

async function loadEntity(dbx: Db | Tx, req: Request, entityType: string, entityId: string, mode: 'view' | 'edit') {
  const e = await ruleFor(dbx, entityType, entityId);
  if (!e) throw Errors.rule('ENTITY_NOT_SUPPORTED', `Documents cannot be attached to ${entityType}.`);
  const perm = mode === 'view' ? e.view : e.edit.find((p) => can(req, p));
  if (!perm || !can(req, perm)) throw Errors.forbidden(mode === 'view' ? e.view : e.edit[0]);
  const row = (await dbx.query(`select * from ${e.table} where id = $1`, [entityId])).rows[0];
  if (!row) throw Errors.notFound('Record');
  if ((e.scope === 'id' || e.scope === 'legal_entity_id') && !inLegalEntityScope(req, perm, row[e.scope])) throw Errors.notFound('Record');
  if (e.scope === 'territory') {
    const ids = await territoryScope(dbx, req, perm);
    if (ids !== null) {
      const ok = await dbx.query(
        `select 1 from mdm.dealer_profiles dp join org.territories dt on dt.id = dp.territory_id join org.territories ut on dt.path <@ ut.path
          where dp.party_id = $1 and ut.id = any($2::uuid[])`, [entityId, ids]);
      if (!ok.rowCount) throw Errors.notFound('Record');
    }
  }
  return row;
}

async function assertSensitiveAccess(dbx: Db, req: Request, entityType: string, entityId: string, sensitive: boolean) {
  const perm = (await ruleFor(dbx, entityType, entityId))?.sensitivePerm;
  if (sensitive && perm && !can(req, perm)) throw Errors.forbidden(perm);
}

export function documentRoutes(db: Db, cfg: Config, storage: FileStorage) {
  const r = Router();
  const sign = (versionId: string, userId: string, exp: number) =>
    createHmac('sha256', Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64')).update(`${versionId}.${userId}.${exp}`).digest('base64url');

  r.get('/types', asyncHandler(async (req, res) => {
    const entityType = str(req.query.entityType);
    const rows = await db.query(
      `select code, name, requires_expiry as "requiresExpiry", sensitive, max_size_mb as "maxSizeMb" from sys.document_types
        where status = 'Active' and ($1::text is null or $1 = any(entity_types)) order by name`, [entityType ?? null]);
    res.json({ data: rows.rows });
  }));

  r.get('/', asyncHandler(async (req, res) => {
    const entityType = str(req.query.entityType);
    const entityId = str(req.query.entityId);
    if (!entityType || !entityId) throw Errors.validation([{ field: 'entityId', message: 'entityType and entityId are required' }]);
    await loadEntity(db, req, entityType, entityId, 'view');
    const docs = await db.query(
      `select d.id, d.document_type as "documentType", t.name as "typeName", t.sensitive, d.title, d.current_version as "currentVersion", d.valid_until as "validUntil",
              d.status, d.created_at as "createdAt",
              coalesce((select json_agg(json_build_object('id', v.id, 'version', v.version, 'note', v.note, 'createdAt', v.created_at, 'createdBy', u.full_name,
                      'fileName', f.original_name, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'avStatus', f.av_status, 'validUntil', v.valid_until) order by v.version desc)
                 from sys.document_versions v join sys.files f on f.id = v.file_id left join iam.users u on u.id = v.created_by where v.document_id = d.id), '[]') as versions
         from sys.documents d join sys.document_types t on t.code = d.document_type
        where d.entity_type = $1 and d.entity_id = $2 order by d.status, t.name, d.title`, [entityType, entityId]);
    const editable = (await ruleFor(db, entityType, entityId))!.edit.some((p) => can(req, p));
    res.json({ data: docs.rows, canUpload: editable });
  }));

  const raw = express.raw({ type: () => true, limit: '50mb' });

  async function storeUpload(tx: Tx, req: Request, maxMb: number) {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw Errors.validation([{ field: 'file', message: 'Choose a file' }]);
    if (body.length > maxMb * 1024 * 1024) throw Errors.rule('FILE_TOO_LARGE', `The file is larger than ${maxMb} MB.`);
    const mime = sniffMime(body);
    if (!mime) throw Errors.rule('FILE_TYPE_NOT_ALLOWED', 'Only PDF, PNG and JPEG files are accepted.');
    const name = (str(req.query.fileName) ?? 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 150);
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    await storage.put(key, body, mime);
    const f = await tx.query(
      `insert into sys.files (storage_key, original_name, mime, size_bytes, sha256, uploaded_by) values ($1,$2,$3,$4,$5,$6) returning id`,
      [key, name, mime, body.length, createHash('sha256').update(body).digest('hex'), req.auth!.user.id]);
    return { fileId: f.rows[0].id as string, name };
  }

  // Upload a new document. Metadata travels in the query string, the file is the raw request body.
  r.post('/', raw, asyncHandler(async (req, res) => {
    const meta = parse(documentMetaSchema, req.query);
    const out = await withTx(db, async (tx) => {
      const entity = await loadEntity(tx, req, meta.entityType, meta.entityId, 'edit');
      if (entity.status === 'Inactive') throw Errors.state('Documents cannot be added to an inactive record.');
      const type = (await tx.query(`select * from sys.document_types where code = $1 and status = 'Active'`, [meta.documentType])).rows[0];
      if (!type || !type.entity_types.includes(meta.entityType)) throw Errors.rule('DOCUMENT_TYPE_INVALID', 'This document type cannot be attached here.');
      if (type.requires_expiry && !meta.validUntil) throw Errors.validation([{ field: 'validUntil', message: 'Expiry date is required for this document type' }]);
      const { fileId, name } = await storeUpload(tx, req, type.max_size_mb);
      const d = (await tx.query(
        `insert into sys.documents (document_type, entity_type, entity_id, title, valid_until, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [meta.documentType, meta.entityType, meta.entityId, meta.title, meta.validUntil ?? null, req.auth!.user.id])).rows[0];
      await tx.query(`insert into sys.document_versions (document_id, version, file_id, valid_until, note, created_by) values ($1,1,$2,$3,$4,$5)`,
        [d.id, fileId, meta.validUntil ?? null, meta.note, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'document.uploaded', entityType: meta.entityType, entityId: meta.entityId,
        after: { documentId: d.id, type: meta.documentType, title: meta.title, fileName: name, validUntil: meta.validUntil ?? null } });
      return d;
    });
    res.status(201).json({ id: out.id });
  }));

  // New version (e.g. a renewed licence). Earlier versions stay available.
  r.post('/:id/versions', raw, asyncHandler(async (req, res) => {
    const validUntil = str(req.query.validUntil) ?? null;
    const note = str(req.query.note) ?? '';
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw Errors.validation([{ field: 'validUntil', message: 'Invalid date' }]);
    const out = await withTx(db, async (tx) => {
      const d = (await tx.query(`select d.*, t.requires_expiry, t.max_size_mb from sys.documents d join sys.document_types t on t.code = d.document_type where d.id = $1 for update of d`, [req.params.id])).rows[0];
      if (!d) throw Errors.notFound('Document');
      await loadEntity(tx, req, d.entity_type, d.entity_id, 'edit');
      if (d.status !== 'Active') throw Errors.state('Archived documents cannot get new versions.');
      if (d.requires_expiry && !validUntil) throw Errors.validation([{ field: 'validUntil', message: 'Expiry date is required for this document type' }]);
      const { fileId, name } = await storeUpload(tx, req, d.max_size_mb);
      const version = d.current_version + 1;
      await tx.query(`insert into sys.document_versions (document_id, version, file_id, valid_until, note, created_by) values ($1,$2,$3,$4,$5,$6)`,
        [d.id, version, fileId, validUntil, note, req.auth!.user.id]);
      await tx.query(`update sys.documents set current_version = $2, valid_until = $3, updated_at = now() where id = $1`, [d.id, version, validUntil]);
      await audit(tx, actorOf(req), { action: 'document.version_added', entityType: d.entity_type, entityId: d.entity_id,
        after: { documentId: d.id, version, fileName: name, validUntil }, reason: note || null });
      return { version };
    });
    res.status(201).json(out);
  }));

  // Short-lived signed link (5 minutes). Issuing it is audited; so is every download.
  r.post('/versions/:versionId/link', asyncHandler(async (req, res) => {
    const v = (await db.query(
      `select v.id, d.entity_type, d.entity_id, d.title, t.sensitive from sys.document_versions v join sys.documents d on d.id = v.document_id
         join sys.document_types t on t.code = d.document_type where v.id = $1`, [req.params.versionId])).rows[0];
    if (!v) throw Errors.notFound('Document');
    await loadEntity(db, req, v.entity_type, v.entity_id, 'view');
    await assertSensitiveAccess(db, req, v.entity_type, v.entity_id, v.sensitive);
    const exp = Math.floor(Date.now() / 1000) + 300;
    await withTx(db, (tx) => audit(tx, actorOf(req), { action: 'document.link_issued', entityType: v.entity_type, entityId: v.entity_id, after: { versionId: v.id, title: v.title, sensitive: v.sensitive } }));
    res.json({ url: `/api/v1/documents/files/${v.id}?exp=${exp}&sig=${sign(v.id, req.auth!.user.id, exp)}`, expiresAt: new Date(exp * 1000).toISOString() });
  }));

  r.get('/files/:versionId', asyncHandler(async (req, res) => {
    const exp = Number(req.query.exp);
    const sig = str(req.query.sig) ?? '';
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) throw new AppError(410, 'LINK_EXPIRED', 'This download link has expired. Open the document again.');
    if (!safeEqual(sig, sign(req.params.versionId!, req.auth!.user.id, exp))) throw Errors.forbidden('document link');
    const v = (await db.query(
      `select f.storage_key, f.mime, f.original_name, d.entity_type, d.entity_id, t.sensitive from sys.document_versions v join sys.files f on f.id = v.file_id
         join sys.documents d on d.id = v.document_id join sys.document_types t on t.code = d.document_type where v.id = $1`, [req.params.versionId])).rows[0];
    if (!v) throw Errors.notFound('Document');
    await loadEntity(db, req, v.entity_type, v.entity_id, 'view');
    await assertSensitiveAccess(db, req, v.entity_type, v.entity_id, v.sensitive);
    await withTx(db, (tx) => audit(tx, actorOf(req), { action: 'document.downloaded', entityType: v.entity_type, entityId: v.entity_id, after: { versionId: req.params.versionId } }));
    res.setHeader('Content-Type', v.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(v.original_name)}"`);
    (await storage.get(v.storage_key)).pipe(res);
  }));

  r.post('/:id/archive', asyncHandler(async (req, res) => {
    const reason = str(req.body?.reason);
    if (!reason) throw Errors.validation([{ field: 'reason', message: 'Required' }]);
    await withTx(db, async (tx) => {
      const d = (await tx.query(`select * from sys.documents where id = $1 for update`, [req.params.id])).rows[0];
      if (!d) throw Errors.notFound('Document');
      await loadEntity(tx, req, d.entity_type, d.entity_id, 'edit');
      if (d.status !== 'Active') throw Errors.state('Already archived.');
      await tx.query(`update sys.documents set status = 'Archived', updated_at = now() where id = $1`, [d.id]);
      await audit(tx, actorOf(req), { action: 'document.archived', entityType: d.entity_type, entityId: d.entity_id, after: { documentId: d.id }, reason });
    });
    res.json({ ok: true });
  }));

  return r;
}
