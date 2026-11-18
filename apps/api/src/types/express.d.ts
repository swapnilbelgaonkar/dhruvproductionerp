import type { AuthContext } from '../middleware/context';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}
export {};
