import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import {
  validateBody,
  validateQuery,
  validateParams,
  createInspectionTemplateSchema,
  inspectionTemplateIdSchema,
  inspectionPublishSchema,
  inspectionCloseSchema,
  inspectionRevokeSchema,
  submitInspectionSchema,
  inspectionRecordIdSchema,
  inspectionFiltersSchema,
} from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.post(
  '/templates',
  validateBody(createInspectionTemplateSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || req.body.operator;
      const { operator: _operator, ...templateData } = req.body;
      const template = inspectionService.createTemplate(templateData, operator);
      res.json({ success: true, data: template, message: '巡检模板创建成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/templates',
  validateQuery(inspectionFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = inspectionService.listTemplatesWithDetails(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/templates/:id',
  validateParams(inspectionTemplateIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const template = inspectionService.getTemplateWithDetails(req.params.id, operator);
      res.json({ success: true, data: template });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/templates/:id/publish',
  validateParams(inspectionTemplateIdSchema),
  validateBody(inspectionPublishSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || req.body.operator;
      const { reason } = req.body;
      const template = inspectionService.publishTemplate(req.params.id, operator, reason);
      res.json({ success: true, data: template, message: '巡检模板发布成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/templates/:id/close',
  validateParams(inspectionTemplateIdSchema),
  validateBody(inspectionCloseSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || req.body.operator;
      const { reason } = req.body;
      const template = inspectionService.closeTemplate(req.params.id, operator, reason);
      res.json({ success: true, data: template, message: '巡检模板关闭成功，历史巡检记录保持不变' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/templates/:id/revoke',
  validateParams(inspectionTemplateIdSchema),
  validateBody(inspectionRevokeSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || req.body.operator;
      const { reason } = req.body;
      const template = inspectionService.revokeTemplate(req.params.id, operator, reason);
      res.json({ success: true, data: template, message: '巡检模板撤销成功，历史巡检记录保持不变，不可恢复' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/records/submit',
  validateBody(submitInspectionSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || req.body.operator;
      const { operator: _operator, ...inspectionData } = req.body;
      const record = inspectionService.submitInspection(inspectionData, operator);
      res.json({ success: true, data: record, message: record.isLate ? '巡检提交成功（迟到）' : '巡检提交成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/records',
  validateQuery(inspectionFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = inspectionService.listInspectionsWithDetails(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/records/:id',
  validateParams(inspectionRecordIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const record = inspectionService.getInspection(req.params.id, operator);
      res.json({ success: true, data: record });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/stats/counts',
  validateQuery(inspectionFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = inspectionService.getStats(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/export',
  validateQuery(inspectionFiltersSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { inspectionService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = inspectionService.export(req.query as any, operator);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
