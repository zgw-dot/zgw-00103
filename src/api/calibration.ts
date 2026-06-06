import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import {
  validateBody,
  validateQuery,
  validateParams,
  createCalibrationPlanSchema,
  calibrationPlanIdSchema,
  calibrationFiltersSchema,
  calibrationDeactivateSchema,
  calibrationRevokeSchema,
} from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.post(
  '/plans',
  validateBody(createCalibrationPlanSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const { operator, ...planData } = req.body;
      const plan = calibrationService.createPlan(planData, operator);
      res.json({ success: true, data: plan, message: '校准计划创建成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/plans',
  validateQuery(calibrationFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = calibrationService.listPlans(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/plans/:id',
  validateParams(calibrationPlanIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const plan = calibrationService.getPlan(req.params.id);
      res.json({ success: true, data: plan });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/plans/:id/deactivate',
  validateParams(calibrationPlanIdSchema),
  validateBody(calibrationDeactivateSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const { operator } = req.body;
      const plan = calibrationService.deactivatePlan(req.params.id, operator);
      res.json({ success: true, data: plan, message: '校准计划停用成功，历史校准结果保持不变' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/plans/:id/revoke',
  validateParams(calibrationPlanIdSchema),
  validateBody(calibrationRevokeSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const { operator } = req.body;
      const plan = calibrationService.revokePlan(req.params.id, operator);
      res.json({ success: true, data: plan, message: '校准计划撤销成功，历史校准结果保持不变' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/plans/:id/corrections',
  validateParams(calibrationPlanIdSchema),
  validateQuery(calibrationFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = calibrationService.getCorrectionsForPlan(req.params.id, req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/corrections',
  validateQuery(calibrationFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = calibrationService.listCorrections(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/corrections/batch/:batchId',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = calibrationService.getCorrectionsForBatch(req.params.batchId, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/export',
  validateQuery(calibrationFiltersSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { calibrationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = calibrationService.export(req.query as any, operator);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
