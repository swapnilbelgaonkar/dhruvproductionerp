export const SALES_TIERS = ['BH', 'NSM', 'DSM', 'ZSM', 'RSM', 'SASM', 'ASM', 'TSM', 'SE'] as const;
export type SalesTier = (typeof SALES_TIERS)[number];

export const MASTER_STATUSES = ['Draft', 'Submitted', 'Active', 'Rejected', 'Inactive'] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];

export const SIMPLE_STATUSES = ['Active', 'Inactive'] as const;

export const USER_STATUSES = ['Active', 'Suspended', 'Deactivated'] as const;

export const WAREHOUSE_TYPES = ['FG', 'RM', 'PM', 'LAB', 'QUARANTINE', 'REJECTED', 'TRANSIT', 'SAMPLE', 'GENERAL'] as const;

export const APPROVAL_STATUSES = ['Pending', 'OnHold', 'Approved', 'Rejected', 'Returned', 'Cancelled'] as const;
export const APPROVAL_DECISIONS = ['Approve', 'Reject', 'Hold', 'Resume', 'Return', 'Cancel'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
