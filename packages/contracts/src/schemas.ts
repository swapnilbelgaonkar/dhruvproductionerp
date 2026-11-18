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
  z.object({ kind: z.literal('role'), label: trimmed(120), roles: z.array(z.string()).min(1), slaHours: z.number().positive().optional() }),
  z.object({ kind: z.literal('reporting_manager'), label: trimmed(120), slaHours: z.number().positive().optional() }),
  z.object({
    kind: z.literal('authority_ladder'), label: trimmed(120), amountFact: z.string().default('amount'),
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
