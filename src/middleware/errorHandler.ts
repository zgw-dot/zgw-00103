import { Request, Response, NextFunction } from 'express';
import { BusinessError, ValidationError, UnauthorizedError, NotFoundError, ConflictError } from '../utils/errors';
import logger from '../utils/logger';
import { ApiResponse } from '../types';

export function errorHandler(
  error: Error,
  req: Request,
  res: Response<ApiResponse>,
  next: NextFunction
): void {
  logger.error('Request error', {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: error.stack,
  });

  if (error instanceof ValidationError) {
    res.status(400).json({
      success: false,
      message: error.message,
      errors: error.details?.errors || [error.message],
    });
    return;
  }

  if (error instanceof UnauthorizedError) {
    res.status(403).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof NotFoundError) {
    res.status(404).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof ConflictError) {
    res.status(409).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof BusinessError) {
    res.status(400).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? '服务器内部错误'
      : error.message || '未知错误',
  });
}

export function notFoundHandler(req: Request, res: Response<ApiResponse>): void {
  res.status(404).json({
    success: false,
    message: `接口不存在: ${req.method} ${req.path}`,
  });
}
