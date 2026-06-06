import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import { validateQuery, queryFiltersSchema, exportSchema } from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.get(
  '/logs',
  validateQuery(queryFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { auditService } = services;
      const result = auditService.listAuditLogs(req.query as any);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/export',
  validateQuery(exportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { auditService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const { content, contentType, filename } = auditService.export(
        req.query as any,
        operator
      );

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
