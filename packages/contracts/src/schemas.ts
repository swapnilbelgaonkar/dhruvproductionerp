import { z } from 'zod';
import { GSTIN_PATTERN, PAN_PATTERN, STATE_CODE_PATTERN, validateGstin } from './gst';
import { APPROVAL_DECISIONS, SALES_TIERS, WAREHOUSE_TYPES } from './enums';

const trimmed = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2–20 letters, digits or hyphens');
const uuid = z.string().uuid();

export const gstinSchema = z
  .string().trim().toUpperCase()
  .regex(GSTIN_PATTERN, 'GSTIN must be 15 characters in the official format')
  .refine((v) => validateGstin(v).valid, 'GSTIN check digit is invalid');
export const panSchema = z.string().trim().toUpperCase().regex(PAN_PATTERN, 'PAN format is AAAAA9999A');
export const stateCodeSchema = z.string().regex(STATE_CODE_PATTERN, 'Two-digit GST state code');

// ---------- Auth ----------
export const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(256) });
export const totpSchema = z.object({ code: z.string().regex(/^[0-9]{6}$/, 'Enter the 6-digit code') });
export const passwordPolicy = z
  .string().min(12, 'At least 12 characters').max(128)
  .regex(/[A-Za-z]/, 'Include a letter').regex(/[0-9]/, 'Include a digit');
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordPolicy });

// ---------- Users & roles ----------
export const scopeSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    legalEntityIds: z.array(uuid).default([]),
    plantIds: z.array(uuid).default([]),
    warehouseIds: z.array(uuid).default([]),
    territoryIds: z.array(uuid).default([]),
  }),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: trimmed(120),
  initialPassword: passwordPolicy,
  employeeId: uuid.optional().nullable(),
});
export const updateUserSchema = z.object({ fullName: trimmed(120), employeeId: uuid.optional().nullable(), version: z.number().int() });
export const grantRoleSchema = z.object({ roleId: uuid, scope: scopeSchema, reason: trimmed(500) });
export const reasonSchema = z.object({ reason: trimmed(500) });

// ---------- Organisation masters ----------
export const legalEntitySchema = z.object({
  code, name: trimmed(150), pan: panSchema.optional().nullable(), cin: optionalText(21),
  registeredAddress: optionalText(500), stateCode: stateCodeSchema.optional().nullable(),
});
export const gstRegistrationSchema = z.object({ gstin: gstinSchema, address: optionalText(500) });
export const plantSchema = z.object({
  legalEntityId: uuid, code, name: trimmed(120), address: optionalText(500), stateCode: stateCodeSchema.optional().nullable(),
});
export const warehouseSchema = z.object({
  legalEntityId: uuid, plantId: uuid.optional().nullable(), code, name: trimmed(120),
  type: z.enum(WAREHOUSE_TYPES), address: optionalText(500), stateCode: stateCodeSchema.optional().nullable(),
  gstRegistrationId: uuid.optional().nullable(),
});
export const departmentSchema = z.object({ code, name: trimmed(120) });
export const territorySchema = z.object({ parentId: uuid.optional().nullable(), code, name: trimmed(120), level: z.number().int().min(1).max(12) });
export const employeeSchema = z.object({
  empCode: code, fullName: trimmed(120), email: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
  mobile: z.string().regex(/^[6-9][0-9]{9}$/, '10-digit Indian mobile number').optional().nullable().or(z.literal('').transform(() => null)),
  departmentId: uuid.optional().nullable(), designation: optionalText(120), salesTier: z.enum(SALES_TIERS).optional().nullable(),
  managerId: uuid.optional().nullable(), territoryId: uuid.optional().nullable(), legalEntityId: uuid.optional().nullable(),
});
export const withVersion = <T extends z.ZodRawShape>(s: z.ZodObject<T>) => s.extend({ version: z.number().int() });

// ---------- Workflow ----------
type Condition = { all?: Condition[]; any?: Condition[]; fact?: string; op?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value?: unknown };
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.object({
    all: z.array(conditionSchema).optional(), any: z.array(conditionSchema).optional(),
    fact: z.string().optional(), op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']).optional(), value: z.unknown().optional(),
  }),
);
export const stepDefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), key: z.string().optional(), label: trimmed(120), roles: z.array(z.string()).min(1), slaHours: z.number().positive().optional() }),
  z.object({ kind: z.literal('reporting_manager'), key: z.string().optional(), label: trimmed(120), slaHours: z.number().positive().optional() }),
  z.object({
    kind: z.literal('authority_ladder'), key: z.string().optional(), label: trimmed(120), amountFact: z.string().default('amount'),
    discountFact: z.string().default('maxDiscountPct'), notifySkipped: z.boolean().default(true), slaHours: z.number().positive().optional(),
    /** While authority limits are inactive (D15): block live submissions, or route them to the initiator's reporting manager. */
    whenLimitsInactive: z.enum(['block', 'reporting_manager']).default('block'),
  }),
]);
export const policyDefinitionSchema = z.object({
  distinctApprovers: z.boolean().default(true),
  rules: z.array(z.object({ name: trimmed(120), when: conditionSchema.optional(), steps: z.array(stepDefSchema) })).min(1),
});
export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
export type StepDef = z.infer<typeof stepDefSchema>;
export type PolicyCondition = Condition;

export const decisionSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS), remarks: z.string().trim().max(1000).optional().default(''),
}).refine((d) => !['Reject', 'Hold', 'Return'].includes(d.decision) || d.remarks.length > 0, {
  message: 'Remarks are required for reject, hold and return', path: ['remarks'],
});
export const simulateSchema = z.object({
  docType: z.string(), initiatorUserId: uuid, facts: z.record(z.unknown()),
});
export const authorityLimitSchema = z.object({
  maxDiscountPct: z.number().min(0).max(100).nullable(), maxOrderValue: z.number().min(0).nullable(), version: z.number().int(),
});
export const numberSeriesFormatSchema = z.object({ prefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/), padding: z.number().int().min(3).max(10) });

// ---------- Product master data (MDM-008…010) ----------
export const ITEM_TYPES = ['FG', 'RM', 'PM', 'SEMI', 'LAB', 'SERVICE'] as const;
export const LICENCE_TYPES = ['NONE', 'FERTILIZER', 'PESTICIDE', 'BIOSTIMULANT'] as const;
export const UOM_DIMENSIONS = ['MASS', 'VOLUME', 'COUNT', 'LENGTH', 'AREA'] as const;

export const uomSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Up to 10 letters/digits'),
  name: trimmed(60), dimension: z.enum(UOM_DIMENSIONS), decimals: z.number().int().min(0).max(6),
});
export const uomConversionSchema = z.object({
  itemId: uuid.optional().nullable(), fromUom: z.string().min(1), toUom: z.string().min(1),
  factor: z.number().positive('Must be greater than zero'),
}).refine((v) => v.fromUom !== v.toUom, { message: 'Choose two different units', path: ['toUom'] });
export const hsnSchema = z.object({
  code: z.string().trim().regex(/^[0-9]{4}([0-9]{2}){0,2}$/, 'HSN/SAC has 4, 6 or 8 digits'),
  kind: z.enum(['HSN', 'SAC']).default('HSN'), description: trimmed(300),
});
export const taxRateSchema = z.object({
  gstRate: z.number().min(0).max(100), cessRate: z.number().min(0).max(100).default(0),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date required'), notes: trimmed(500),
});
export const productCategorySchema = z.object({ code, name: trimmed(120), licenceRequired: z.enum(LICENCE_TYPES) });
export const itemSchema = z.object({
  code, name: trimmed(150), itemType: z.enum(ITEM_TYPES), categoryId: uuid.optional().nullable(),
  baseUom: z.string().min(1).optional().nullable().transform((v) => v || null), hsnId: uuid.optional().nullable(), formulation: optionalText(500),
  activeIngredient: optionalText(500), composition: optionalText(1000), keyBenefits: optionalText(2000), advisoryDosage: optionalText(1000),
  fcoGrade: optionalText(40), brochurePage: z.coerce.number().int().positive().optional().nullable(),
  shelfLifeDays: z.coerce.number().int().positive().optional().nullable(), storageClass: optionalText(60),
  lotControlled: z.boolean().default(true), serialControlled: z.boolean().default(false), hazardous: z.boolean().default(false),
});
export const itemPackSchema = z.object({
  packCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Letters, digits, hyphen'),
  packSize: z.number().positive(), packUom: z.string().min(1), container: optionalText(40),
  unitsPerBox: z.number().int().positive().default(1), gtin: z.string().regex(/^[0-9]{8,14}$/, '8–14 digits').optional().nullable(),
});

// ---------- Documents ----------
export const documentMetaSchema = z.object({
  documentType: z.string().min(1), entityType: z.string().min(1), entityId: uuid,
  title: trimmed(200), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), note: z.string().max(500).optional().default(''),
});

// ---------- Dealers (BRD §3.1, MP Part 6) ----------
export const CONSTITUTIONS = ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PVT_LTD', 'PUBLIC_LTD', 'FPO'] as const;
export const DEALER_CATEGORIES = ['DISTRIBUTOR', 'DEALER', 'RETAILER', 'INSTITUTION'] as const;
export const DEALER_LICENCE_TYPES = ['FERTILIZER', 'PESTICIDE', 'BIOSTIMULANT'] as const;
/** Vendors may also hold a CIB&RC registration (pesticide technicals) and a factory manufacturing licence (BRD p.8). */
export const VENDOR_LICENCE_TYPES = ['FERTILIZER', 'PESTICIDE', 'BIOSTIMULANT', 'CIB_REGISTRATION', 'MANUFACTURING'] as const;
export const PARTY_LICENCE_TYPES = VENDOR_LICENCE_TYPES;
export const VENDOR_CATEGORIES = ['RAW_MATERIAL', 'PACKAGING', 'LAB_CONSUMABLE', 'SERVICES', 'CAPITAL', 'OTHER'] as const;
export const ID_TYPES = ['PAN', 'AADHAAR', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE'] as const;

const mobile = z.string().trim().regex(/^[6-9][0-9]{9}$/, '10-digit Indian mobile number');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date required');

// KYC fields, category, territory and sales owner may be empty on a Draft dealer; the onboarding checklist requires them before submission.
export const dealerSchema = z.object({
  legalName: trimmed(150), tradeName: optionalText(150), constitution: z.enum(CONSTITUTIONS).optional().nullable(),
  pan: panSchema.optional().nullable(), gstRegistered: z.boolean(), gstin: gstinSchema.optional().nullable(),
  contactPerson: optionalText(100), mobile: mobile.optional().nullable().or(z.literal('').transform(() => null)), phoneNumbers: optionalText(200),
  email: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
  dealerCategory: z.enum(DEALER_CATEGORIES).optional().nullable(), territoryId: uuid.optional().nullable(), salesOwnerId: uuid.optional().nullable(),
  licenceTypes: z.array(z.enum(DEALER_LICENCE_TYPES)).default([]),
  priceGroup: z.string().trim().min(1).max(30).default('STANDARD'),
  creditDays: z.number().int().min(0).max(365), creditLimit: z.number().min(0),
  annualTarget: z.number().min(0).optional().nullable(), targetFy: z.string().regex(/^\d{4}-\d{2}$/, 'e.g. 2026-27').optional().nullable(),
}).superRefine((d, ctx) => {
  if (d.gstRegistered && !d.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN is required for a GST-registered dealer' });
  if (d.gstin && d.pan && d.gstin.slice(2, 12) !== d.pan) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN characters 3–12 must equal the PAN' });
  if (d.creditLimit > 0 && d.creditDays === 0) ctx.addIssue({ code: 'custom', path: ['creditDays'], message: 'Credit days are needed when a credit limit is given' });
});
export const addressSchema = z.object({
  kind: z.enum(['REGISTERED', 'BILLING', 'SHIPPING']), label: optionalText(60), line1: trimmed(200), line2: optionalText(200),
  city: trimmed(80), district: trimmed(80), stateCode: stateCodeSchema, pincode: z.string().regex(/^[1-9][0-9]{5}$/, '6-digit PIN code'),
  isDefault: z.boolean().default(false),
});
export const licenceSchema = z.object({
  licenceType: z.enum(PARTY_LICENCE_TYPES), number: trimmed(60), issuer: trimmed(150),
  validFrom: isoDate, validTo: isoDate, documentId: uuid,
}).refine((l) => l.validTo >= l.validFrom, { message: 'Valid-to must be after valid-from', path: ['validTo'] });
export const signatorySchema = z.object({
  fullName: trimmed(100), designation: trimmed(60), idType: z.enum(ID_TYPES),
  idLast4: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'Last 4 characters only — never the full number'), documentId: uuid,
});
export const licenceVerifySchema = z.object({ verification: z.enum(['Verified', 'Rejected']), remarks: z.string().trim().max(500).optional().default('') })
  .refine((v) => v.verification === 'Verified' || v.remarks.length > 0, { message: 'Give the reason for rejection', path: ['remarks'] });

// ---------- CRM (BRD §4 #1–5) ----------
export const LEAD_SOURCES = ['EXHIBITION', 'INDIAMART', 'FIELD_VISIT', 'REFERRAL', 'DEALER_ENQUIRY', 'WEBSITE', 'OTHER'] as const;
export const OPP_STAGES = ['REQUIREMENT', 'SAMPLE_TRIAL', 'QUOTE_SENT', 'PO_EXPECTED', 'WON', 'LOST'] as const;
export const OPEN_STAGES = ['REQUIREMENT', 'SAMPLE_TRIAL', 'QUOTE_SENT', 'PO_EXPECTED'] as const;
export const LOSS_REASONS = ['PRICE', 'COMPETITOR', 'NO_BUDGET', 'NO_NEED', 'TIMING', 'PRODUCT_FIT', 'NO_RESPONSE', 'OTHER'] as const;
export const ACTIVITY_KINDS = ['CALL', 'MEETING', 'DEALER_VISIT', 'FIELD_VISIT', 'AGRONOMIST', 'FOLLOW_UP', 'TASK'] as const;

export const leadSchema = z.object({
  company: trimmed(150), contactPerson: trimmed(100), mobile: z.string().trim().regex(/^[6-9][0-9]{9}$/, '10-digit Indian mobile number'),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
  source: z.enum(LEAD_SOURCES), sourceDetail: optionalText(200), territoryId: uuid, ownerId: uuid,
  productInterest: trimmed(300), expectedQty: z.number().min(0).optional().nullable(), expectedUom: z.string().optional().nullable(),
  followUpAt: z.string().datetime({ offset: true }).optional().nullable(), partyId: uuid.optional().nullable(), notes: optionalText(2000),
});
export const bantSchema = z.object({
  budget: z.boolean(), authority: z.boolean(), decisionMaker: optionalText(100),
  needScore: z.number().int().min(1).max(5), timeline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date required'),
});
export const leadTransferSchema = z.object({ ownerId: uuid, territoryId: uuid.optional(), reason: trimmed(500) });
export const leadDisqualifySchema = z.object({ reason: trimmed(500) });
export const opportunitySchema = z.object({
  title: trimmed(200), value: z.number().min(0), probability: z.number().int().min(0).max(100),
  expectedClose: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), productInterest: optionalText(300), partyId: uuid.optional().nullable(),
});
export const stageChangeSchema = z.object({
  stage: z.enum(OPP_STAGES), lossReason: z.enum(LOSS_REASONS).optional().nullable(), note: z.string().trim().max(1000).optional().default(''),
}).refine((s) => s.stage !== 'LOST' || !!s.lossReason, { message: 'Choose why it was lost', path: ['lossReason'] });
export const activitySchema = z.object({
  subjectType: z.enum(['lead', 'opportunity', 'dealer']), subjectId: uuid, kind: z.enum(ACTIVITY_KINDS), title: trimmed(200),
  notes: optionalText(2000), plannedAt: z.string().datetime({ offset: true }),
  done: z.boolean().default(false), outcome: optionalText(1000),
  latitude: z.number().min(-90).max(90).optional().nullable(), longitude: z.number().min(-180).max(180).optional().nullable(),
}).refine((a) => !a.done || !!a.outcome, { message: 'Record the outcome', path: ['outcome'] });
export const activityCompleteSchema = z.object({
  outcome: trimmed(1000), nextAction: z.object({ kind: z.enum(ACTIVITY_KINDS), title: trimmed(200), plannedAt: z.string().datetime({ offset: true }) }).optional().nullable(),
});

// ---------- Pricing & quotations (BRD §4 #9, §5.1) ----------
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date required');
export const priceListSchema = z.object({
  code, name: trimmed(120), priceGroup: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,30}$/, 'Letters, digits, - or _'),
  validFrom: isoDay, validTo: isoDay.optional().nullable(), notes: optionalText(500),
});
export const priceListItemSchema = z.object({
  itemPackId: uuid, rate: z.number().positive('Rate must be above zero'),
  slabs: z.array(z.object({ minQty: z.number().positive(), discountPct: z.number().positive().max(99.99) })).max(10).default([]),
}).refine((v) => new Set(v.slabs.map((s) => s.minQty)).size === v.slabs.length, { message: 'Each slab needs a different minimum quantity', path: ['slabs'] });

export const quotationLineInput = z.object({
  itemPackId: uuid, qty: z.number().positive('Quantity must be above zero'), extraDiscountPct: z.number().min(0).max(100).default(0),
});
const salesDocBase = z.object({
  partyId: uuid, legalEntityId: uuid, billToId: uuid, shipToId: uuid,
  contactPerson: optionalText(100), paymentTerms: trimmed(300), deliveryTerms: trimmed(300), notes: optionalText(1000),
  opportunityId: uuid.optional().nullable(),
  lines: z.array(quotationLineInput).min(1, 'Add at least one item').max(100),
});
const uniquePacks = (q: { lines: { itemPackId: string }[] }) => new Set(q.lines.map((l) => l.itemPackId)).size === q.lines.length;
export const quotationSchema = salesDocBase.extend({ quoteDate: isoDay.optional() })
  .refine(uniquePacks, { message: 'Each product pack can appear only once', path: ['lines'] });

// ---------- Sales orders (BRD §5.2, MP Part 9) ----------
const orderExtras = {
  requiredBy: isoDay.optional().nullable(), dealerPoNo: optionalText(60), dealerPoDate: isoDay.optional().nullable(),
};
export const salesOrderSchema = salesDocBase.extend({ orderDate: isoDay.optional(), ...orderExtras })
  .refine(uniquePacks, { message: 'Each product pack can appear only once', path: ['lines'] });
/** Header changes allowed on any editable order, including one converted from a quotation (whose lines are locked). */
export const salesOrderHeaderSchema = z.object({
  contactPerson: optionalText(100), paymentTerms: trimmed(300), deliveryTerms: trimmed(300), notes: optionalText(1000), ...orderExtras,
});
export const convertQuotationSchema = z.object({ ...orderExtras });

// ---------- Vendors (BRD §3.2 p.8; MDM-011, MDM-016) ----------
// KYC fields may be empty on a Draft vendor; the onboarding checklist requires them before submission.
export const vendorSchema = z.object({
  legalName: trimmed(150), tradeName: optionalText(150), constitution: z.enum(CONSTITUTIONS).optional().nullable(),
  pan: panSchema.optional().nullable(), gstRegistered: z.boolean(), gstin: gstinSchema.optional().nullable(),
  contactPerson: optionalText(100), mobile: mobile.optional().nullable().or(z.literal('').transform(() => null)), phoneNumbers: optionalText(200),
  email: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
  vendorCategory: z.enum(VENDOR_CATEGORIES), licenceTypes: z.array(z.enum(VENDOR_LICENCE_TYPES)).default([]),
  msmeRegistered: z.boolean().default(false),
  udyamNumber: z.string().trim().toUpperCase().regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'Format UDYAM-MH-00-0000000').optional().nullable(),
  paymentTermsDays: z.number().int().min(0).max(180),
}).superRefine((d, ctx) => {
  if (d.gstRegistered && !d.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN is required for a GST-registered vendor' });
  if (d.gstin && d.pan && d.gstin.slice(2, 12) !== d.pan) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN characters 3–12 must equal the PAN' });
  if (d.msmeRegistered && !d.udyamNumber) ctx.addIssue({ code: 'custom', path: ['udyamNumber'], message: 'Udyam number is required for an MSME vendor' });
});
export const bankAccountSchema = z.object({
  accountHolder: trimmed(120), bankName: trimmed(120), branch: optionalText(120),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, '11-character IFSC, e.g. SBIN0001234'),
  accountNumber: z.string().trim().regex(/^[0-9]{9,18}$/, '9 to 18 digits'), documentId: uuid,
});
export const vendorItemSchema = z.object({
  itemId: uuid, vendorItemCode: optionalText(60), leadTimeDays: z.number().int().min(0).max(365), minOrderQty: z.number().positive().optional().nullable(),
});

// ---------- Purchase requisitions (MP §10.1; PUR-001/002) ----------
export const PR_PRIORITIES = ['NORMAL', 'URGENT', 'EMERGENCY'] as const;
export const requisitionLineInput = z.object({
  itemId: uuid, qty: z.number().positive('Quantity must be above zero'), estimatedRate: z.number().min(0).optional().nullable(),
  requiredBy: isoDay.optional().nullable(), suggestedVendorId: uuid.optional().nullable(), remarks: optionalText(300),
});
export const requisitionSchema = z.object({
  legalEntityId: uuid, warehouseId: uuid, departmentId: uuid.optional().nullable(), requiredBy: isoDay,
  priority: z.enum(PR_PRIORITIES), purpose: trimmed(500),
  lines: z.array(requisitionLineInput).min(1, 'Add at least one item').max(100),
}).refine((r) => new Set(r.lines.map((l) => l.itemId)).size === r.lines.length, { message: 'Each item can appear only once', path: ['lines'] });

// ---------- RFQ and comparative statement (MP §10.2–10.3; PUR-004/005/014) ----------
export const rfqSchema = z.object({
  legalEntityId: uuid, warehouseId: uuid, responseDue: isoDay, notes: optionalText(1000),
  lines: z.array(z.object({
    itemId: uuid, qty: z.number().positive(), requiredBy: isoDay.optional().nullable(), specification: optionalText(500), requisitionLineId: uuid.optional().nullable(),
  })).min(1, 'Add at least one item').max(100),
  vendorIds: z.array(uuid).min(1, 'Invite at least one vendor').max(20),
}).refine((r) => new Set(r.lines.map((l) => l.itemId)).size === r.lines.length, { message: 'Each item can appear only once', path: ['lines'] })
  .refine((r) => new Set(r.vendorIds).size === r.vendorIds.length, { message: 'Each vendor can be invited once', path: ['vendorIds'] });
export const vendorQuoteSchema = z.object({
  partyId: uuid, quoteRef: trimmed(60), quoteDate: isoDay, validUntil: isoDay,
  paymentTermsDays: z.number().int().min(0).max(180), deliveryDays: z.number().int().min(0).max(365), freight: z.number().min(0).default(0),
  documentId: uuid.optional().nullable(), remarks: optionalText(500),
  lines: z.array(z.object({ rfqLineId: uuid, rate: z.number().positive(), discountPct: z.number().min(0).max(100).default(0), compliant: z.boolean().default(true), remarks: optionalText(300) })).min(1),
}).refine((q) => q.validUntil >= q.quoteDate, { message: 'Valid-until must be on or after the quote date', path: ['validUntil'] });
export const rfqAwardSchema = z.object({
  lines: z.array(z.object({ rfqLineId: uuid, vendorQuoteId: uuid, overrideReason: optionalText(500) })).min(1),
});

// ---------- Purchase orders (MP §10.4; PUR-006, PUR-013) ----------
export const purchaseOrderLineInput = z.object({
  itemId: uuid, qty: z.number().positive('Quantity must be above zero'), rate: z.number().positive('Rate must be above zero'),
  discountPct: z.number().min(0).max(100).default(0), deliveryDate: isoDay.optional().nullable(), requisitionLineId: uuid.optional().nullable(),
});
export const purchaseOrderSchema = z.object({
  partyId: uuid, legalEntityId: uuid, warehouseId: uuid, poDate: isoDay.optional(), deliveryDate: isoDay,
  paymentTermsDays: z.number().int().min(0).max(180), deliveryTerms: trimmed(300), notes: optionalText(1000), emergency: z.boolean().default(false),
  lines: z.array(purchaseOrderLineInput).min(1, 'Add at least one item').max(100),
}).refine((p) => new Set(p.lines.map((l) => l.itemId)).size === p.lines.length, { message: 'Each item can appear only once', path: ['lines'] });
export const poAcknowledgeSchema = z.object({ vendorAckRef: trimmed(100) });

// ---------- Goods receipt (MP §10.5; PUR-008) ----------
export const goodsReceiptSchema = z.object({
  purchaseOrderId: uuid, receiptDate: isoDay.optional(), challanNo: trimmed(60), challanDate: isoDay.optional().nullable(),
  vendorInvoiceNo: optionalText(60), vehicleNo: optionalText(20), remarks: optionalText(500),
  lines: z.array(z.object({
    poLineId: uuid, challanQty: z.number().min(0), receivedQty: z.number().positive('Received quantity must be above zero'),
    vendorLotNo: optionalText(60), mfgDate: isoDay.optional().nullable(), expiryDate: isoDay.optional().nullable(),
  })).min(1, 'Receive at least one line').max(100),
}).refine((g) => new Set(g.lines.map((l) => l.poLineId)).size === g.lines.length, { message: 'Each PO line can appear once', path: ['lines'] });

// ---------- QC lot inspection and release (BRD p.15; QC-001…) ----------
export const QC_DECISIONS = ['Release', 'Reject', 'Hold'] as const;
export const qcSampleSchema = z.object({ sampleQty: z.number().min(0) });
export const qcResultsSchema = z.object({
  results: z.array(z.object({ parameter: trimmed(120), specification: trimmed(200), result: trimmed(200), pass: z.boolean() })).min(1, 'Record at least one test').max(50),
  coaReceived: z.boolean(), coaDocumentId: uuid.optional().nullable(), recommendation: z.enum(QC_DECISIONS),
});
export const qcDecisionSchema = z.object({ decision: z.enum(QC_DECISIONS), remarks: z.string().trim().max(500).optional().default('') })
  .refine((d) => d.decision === 'Release' || d.remarks.length > 0, { message: 'Give the reason for rejecting or holding the lot', path: ['remarks'] });

// ---------- Supplier returns and invoices (MP §10.5–10.6; PUR-009, PUR-010) ----------
export const RETURN_BUCKETS = ['REJECTED', 'UNRESTRICTED', 'BLOCKED'] as const;
export const supplierReturnSchema = z.object({
  goodsReceiptId: uuid, returnDate: isoDay.optional(), reason: trimmed(500), transporter: optionalText(120), vehicleNo: optionalText(20),
  lines: z.array(z.object({ lotId: uuid, bucket: z.enum(RETURN_BUCKETS), qty: z.number().positive() })).min(1).max(100),
}).refine((r) => new Set(r.lines.map((l) => l.lotId)).size === r.lines.length, { message: 'Each lot can appear once', path: ['lines'] });
export const supplierInvoiceSchema = z.object({
  purchaseOrderId: uuid, invoiceNo: trimmed(60), invoiceDate: isoDay, dueDate: isoDay.optional().nullable(), documentId: uuid.optional().nullable(),
  lines: z.array(z.object({
    poLineId: uuid, qty: z.number().positive(), rate: z.number().positive(), gstRate: z.number().min(0).max(100),
    tax: z.number().min(0).optional().nullable(),          // GST as charged on the invoice; calculated when blank
  })).min(1).max(100),
}).refine((i) => new Set(i.lines.map((l) => l.poLineId)).size === i.lines.length, { message: 'Each PO line can appear once', path: ['lines'] });
export const invoiceExceptionSchema = z.object({ note: trimmed(1000) });

// ---------- Production: plant & line settings, formulations (BRD p.18; MFG-006, MFG-009, MFG-019) ----------
export const LINE_TYPES = ['REACTOR', 'BLENDER', 'GRANULATOR', 'FERMENTER', 'FILLING', 'PACKING', 'OTHER'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
export const productionLineSchema = z.object({
  plantId: uuid, code, name: trimmed(120), lineType: z.enum(LINE_TYPES),
  capacityPerShift: z.number().positive().optional().nullable(), capacityUom: z.string().trim().max(10).optional().nullable().transform((v) => v || null),
  parameters: z.array(z.object({ name: trimmed(80), value: trimmed(80), unit: optionalText(20) })).max(30).default([]),
}).refine((l) => (l.capacityPerShift == null) === (l.capacityUom == null), { message: 'Give both the capacity and its unit, or neither', path: ['capacityUom'] });
export const shiftSchema = z.object({
  plantId: uuid, code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'Use 1–6 letters or digits'), name: trimmed(60),
  startTime: hhmm, endTime: hhmm,
}).refine((s) => s.startTime !== s.endTime, { message: 'Start and end cannot be the same', path: ['endTime'] });
export const bomSchema = z.object({ itemId: uuid, code, name: trimmed(150) });
export const bomVersionSchema = z.object({
  batchSize: z.number().positive('Batch size must be above zero'), standardYieldPct: z.number().positive().max(100),
  reactionTempC: z.number().min(-50).max(500).optional().nullable(), reactionTimeMin: z.number().int().positive().optional().nullable(),
  processNotes: optionalText(2000), effectiveFrom: isoDay, changeNote: trimmed(500),
  lines: z.array(z.object({
    stepNo: z.number().int().positive().default(1), itemId: uuid, qty: z.number().positive('Quantity must be above zero'),
    tolerancePct: z.number().min(0).max(100), notes: optionalText(300),
    alternates: z.array(z.object({ itemId: uuid, factor: z.number().positive().default(1), notes: optionalText(300) })).max(5).default([]),
  })).min(1, 'Add at least one ingredient').max(60),
}).refine((v) => new Set(v.lines.map((l) => l.itemId)).size === v.lines.length, { message: 'Each ingredient can appear only once', path: ['lines'] })
  .refine((v) => v.lines.every((l) => !l.alternates.some((a) => a.itemId === l.itemId)), { message: 'An ingredient cannot be its own substitute', path: ['lines'] });

// ---------- Production orders, material issue and the quarantine override (MP §12.3, §12.5; MFG-005, MFG-007, MFG-013; D33) ----------
export const productionOrderSchema = z.object({
  plantId: uuid, lineId: uuid, itemId: uuid, plannedQty: z.number().positive('Quantity must be above zero'),
  orderType: z.enum(['MTS', 'MTO']), salesOrderId: uuid.optional().nullable(), priority: z.enum(['NORMAL', 'URGENT']).default('NORMAL'),
  plannedStart: isoDay, dueDate: isoDay, shiftId: uuid.optional().nullable(), issueWarehouseId: uuid, fgWarehouseId: uuid, remarks: optionalText(1000),
}).refine((o) => o.dueDate >= o.plannedStart, { message: 'The due date cannot be before the start', path: ['dueDate'] })
  .refine((o) => (o.orderType === 'MTO') === !!o.salesOrderId, { message: 'A make-to-order production order needs its sales order (and only then)', path: ['salesOrderId'] });
export const releaseOrderSchema = z.object({ acceptShortage: z.boolean().default(false), reason: optionalText(500) })
  .refine((r) => !r.acceptShortage || !!r.reason, { message: 'Say why the order is released short of material', path: ['reason'] });
export const materialIssueSchema = z.object({
  remarks: optionalText(500),
  lines: z.array(z.object({ reservationId: uuid, qty: z.number().positive() })).min(1, 'Issue at least one lot').max(100),
}).refine((m) => new Set(m.lines.map((l) => l.reservationId)).size === m.lines.length, { message: 'Each reservation can appear once', path: ['lines'] });
export const materialReturnSchema = z.object({
  remarks: optionalText(500),
  lines: z.array(z.object({ orderMaterialId: uuid, lotId: uuid, qty: z.number().positive() })).min(1, 'Return at least one lot').max(100),
});
export const quarantineOverrideSchema = z.object({ orderMaterialId: uuid, lotId: uuid, qty: z.number().positive(), reason: trimmed(1000) });

// ---------- Batch execution (MP §12.5–12.6; MFG-007, MFG-008, MFG-010; TC-11) ----------
export const batchStartSchema = z.object({
  shiftId: uuid.optional().nullable(), operators: z.array(z.string().trim().min(1).max(80)).min(1, 'Name at least one operator').max(10),
});
export const dosingSchema = z.object({
  orderMaterialId: uuid,
  entries: z.array(z.object({ lotId: uuid, qty: z.number().positive('Quantity must be above zero') })).min(1).max(10),
  deviationReason: optionalText(1000),                      // needed when the dose goes beyond the tolerance (TC-11)
}).refine((d) => new Set(d.entries.map((e) => e.lotId)).size === d.entries.length, { message: 'Each lot can appear once', path: ['entries'] });
export const readingSchema = z.object({ parameter: trimmed(80), value: trimmed(40), unit: optionalText(20), inLimits: z.boolean().optional().nullable(), remarks: optionalText(300) });
export const ipqcRequestSchema = z.object({ stage: trimmed(80) });
export const ipqcResultsSchema = z.object({
  results: z.array(z.object({ parameter: trimmed(120), specification: trimmed(200), result: trimmed(200), pass: z.boolean() })).min(1, 'Record at least one test').max(30),
  remarks: optionalText(500),
});
export const batchCompleteSchema = z.object({
  outputQty: z.number().positive('Output must be above zero'), processLossQty: z.number().min(0).default(0), recoveredQty: z.number().min(0).default(0),
  wasteQty: z.number().min(0).default(0), remarks: optionalText(1000),
  underDoseReason: optionalText(1000), balanceReason: optionalText(1000),
});

// ---------- QC: methods, instruments, specifications, OOS, CoA (BRD p.15; MP §13.3–13.7; QC-004…QC-008, QC-013) ----------
export const QC_TECHNIQUES = ['HPLC', 'AAS', 'TITRATION', 'PH_METER', 'GRAVIMETRIC', 'SPECTROPHOTOMETRY', 'DENSITY', 'VISUAL', 'OTHER'] as const;
export const testMethodSchema = z.object({ code, name: trimmed(150), technique: z.enum(QC_TECHNIQUES), reference: optionalText(200) });
export const instrumentSchema = z.object({
  code, name: trimmed(150), technique: z.enum(QC_TECHNIQUES), makeModel: optionalText(120), serialNo: optionalText(60), location: optionalText(120),
  intervalDays: z.number().int().min(1).max(1095),
});
export const calibrationSchema = z.object({
  calibratedOn: isoDay, result: z.enum(['Pass', 'Fail']), agency: optionalText(150), certificateNo: optionalText(60), documentId: uuid.optional().nullable(), remarks: optionalText(500),
});
export const SPEC_CATEGORIES = ['PHYSICAL', 'CHEMICAL', 'HEAVY_METAL', 'MICROBIAL', 'OTHER'] as const;
export const specSchema = z.object({ itemId: uuid, code, title: trimmed(150) });
export const specVersionSchema = z.object({
  effectiveFrom: isoDay, changeNote: trimmed(500),
  parameters: z.array(z.object({
    parameter: trimmed(120), category: z.enum(SPEC_CATEGORIES), unit: optionalText(20), limitType: z.enum(['RANGE', 'MIN', 'MAX', 'TEXT']),
    minValue: z.number().optional().nullable(), maxValue: z.number().optional().nullable(), expectedText: optionalText(200), methodId: uuid.optional().nullable(),
  }).refine((p) => (p.limitType === 'RANGE' ? p.minValue != null && p.maxValue != null && p.maxValue >= p.minValue
    : p.limitType === 'MIN' ? p.minValue != null : p.limitType === 'MAX' ? p.maxValue != null : !!p.expectedText), { message: 'Give the limits that match the limit type', path: ['minValue'] }))
    .min(1, 'Add at least one parameter').max(40),
});
export const qcSpecResultsSchema = z.object({
  results: z.array(z.object({ specParameterId: uuid, value: trimmed(60), instrumentId: uuid.optional().nullable() })).min(1).max(40),
  coaReceived: z.boolean(), coaDocumentId: uuid.optional().nullable(), recommendation: z.enum(['Release', 'Reject', 'Hold']),
});
export const oosInvestigationSchema = z.object({ phase1Findings: trimmed(2000), authoriseRetest: z.boolean() });
export const oosRetestSchema = z.object({ results: z.array(z.object({ specParameterId: uuid, value: trimmed(60), instrumentId: uuid.optional().nullable() })).min(1).max(40) });
export const oosCloseSchema = z.object({ conclusion: z.enum(['Confirmed', 'Invalidated']), rootCause: trimmed(2000) });
