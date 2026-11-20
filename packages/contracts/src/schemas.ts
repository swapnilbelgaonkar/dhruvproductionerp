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
  baseUom: z.string().min(1, 'Required'), hsnId: uuid.optional().nullable(), formulation: optionalText(500),
  shelfLifeDays: z.coerce.number().int().positive().optional().nullable(), storageClass: optionalText(60),
  lotControlled: z.boolean().default(true), serialControlled: z.boolean().default(false), hazardous: z.boolean().default(false),
});
export const itemPackSchema = z.object({
  packCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Letters, digits, hyphen'),
  packSize: z.number().positive(), packUom: z.string().min(1), container: trimmed(40),
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
export const ID_TYPES = ['PAN', 'AADHAAR', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE'] as const;

const mobile = z.string().trim().regex(/^[6-9][0-9]{9}$/, '10-digit Indian mobile number');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date required');

export const dealerSchema = z.object({
  legalName: trimmed(150), tradeName: optionalText(150), constitution: z.enum(CONSTITUTIONS),
  pan: panSchema, gstRegistered: z.boolean(), gstin: gstinSchema.optional().nullable(),
  contactPerson: trimmed(100), mobile, email: z.string().trim().toLowerCase().email().optional().nullable(),
  dealerCategory: z.enum(DEALER_CATEGORIES), territoryId: uuid, salesOwnerId: uuid,
  licenceTypes: z.array(z.enum(DEALER_LICENCE_TYPES)).default([]),
  priceGroup: z.string().trim().min(1).max(30).default('STANDARD'),
  creditDays: z.number().int().min(0).max(365), creditLimit: z.number().min(0),
  annualTarget: z.number().min(0).optional().nullable(), targetFy: z.string().regex(/^\d{4}-\d{2}$/, 'e.g. 2026-27').optional().nullable(),
}).superRefine((d, ctx) => {
  if (d.gstRegistered && !d.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN is required for a GST-registered dealer' });
  if (d.gstin && d.gstin.slice(2, 12) !== d.pan) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN characters 3–12 must equal the PAN' });
  if (d.creditLimit > 0 && d.creditDays === 0) ctx.addIssue({ code: 'custom', path: ['creditDays'], message: 'Credit days are needed when a credit limit is given' });
});
export const addressSchema = z.object({
  kind: z.enum(['REGISTERED', 'BILLING', 'SHIPPING']), label: optionalText(60), line1: trimmed(200), line2: optionalText(200),
  city: trimmed(80), district: trimmed(80), stateCode: stateCodeSchema, pincode: z.string().regex(/^[1-9][0-9]{5}$/, '6-digit PIN code'),
  isDefault: z.boolean().default(false),
});
export const licenceSchema = z.object({
  licenceType: z.enum(DEALER_LICENCE_TYPES), number: trimmed(60), issuer: trimmed(150),
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
