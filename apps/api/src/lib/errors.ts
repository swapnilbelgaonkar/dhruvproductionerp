export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid.', details),
  authRequired: () => new AppError(401, 'AUTH_REQUIRED', 'Please sign in.'),
  authInvalid: () => new AppError(401, 'AUTH_INVALID', 'Invalid email or password.'),
  forbidden: (perm?: string) => new AppError(403, 'FORBIDDEN', 'You do not have permission for this action.', perm ? { permission: perm } : undefined),
  sod: (msg: string) => new AppError(403, 'SOD_VIOLATION', msg),
  notFound: (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details),
  concurrent: () => new AppError(409, 'CONCURRENT_MODIFICATION', 'This record was changed by someone else. Reload and try again.'),
  state: (msg: string) => new AppError(422, 'INVALID_STATE_TRANSITION', msg),
  rule: (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details),
};
