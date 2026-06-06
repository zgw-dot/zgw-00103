import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError } from '../utils/errors';

export const USER_ID_HEADER = 'x-user-id';

export function getCurrentUserId(req: Request): string {
  const userId = req.headers[USER_ID_HEADER];
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new UnauthorizedError(
      '请求头缺失 X-User-Id，无法识别当前用户身份',
      { reason: 'missing_x_user_id', header: USER_ID_HEADER }
    );
  }
  return userId.trim();
}

export function requireUserId(req: Request, res: Response, next: NextFunction): void {
  try {
    getCurrentUserId(req);
    next();
  } catch (error) {
    next(error);
  }
}
