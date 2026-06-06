import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import { validateBody, validateParams, thresholdSchema, storeThresholdSchema, deviceThresholdSchema, deviceIdSchema, deviceIdParamSchema } from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.get(
  '/default',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const threshold = thresholdService.getDefaultThreshold();
      res.json({ success: true, data: threshold });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/default',
  validateBody(thresholdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const threshold = thresholdService.updateDefaultThreshold(
        req.body.minTemp,
        req.body.maxTemp,
        operator
      );
      res.json({ success: true, data: threshold, message: '默认阈值更新成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/store/:storeId',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const threshold = thresholdService.getStoreThreshold(req.params.storeId);
      res.json({ success: true, data: threshold });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/store/:storeId',
  validateBody(thresholdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const threshold = thresholdService.setStoreThreshold(
        req.params.storeId,
        req.body.minTemp,
        req.body.maxTemp,
        operator
      );
      res.json({ success: true, data: threshold, message: '门店阈值设置成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/store/:storeId',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const result = thresholdService.deleteStoreThreshold(req.params.storeId, operator);
      res.json({ success: true, data: { deleted: result }, message: '门店阈值删除成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/device/:deviceId',
  validateParams(deviceIdParamSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const threshold = thresholdService.getDeviceThreshold(req.params.deviceId);
      res.json({ success: true, data: threshold });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/device/:deviceId/effective',
  validateParams(deviceIdParamSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const threshold = thresholdService.getEffectiveThreshold(req.params.deviceId);
      res.json({ success: true, data: threshold });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/device/:deviceId',
  validateParams(deviceIdParamSchema),
  validateBody(thresholdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const threshold = thresholdService.setDeviceThreshold(
        req.params.deviceId,
        req.body.minTemp,
        req.body.maxTemp,
        operator
      );
      res.json({ success: true, data: threshold, message: '设备阈值设置成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/device/:deviceId',
  validateParams(deviceIdParamSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { thresholdService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const result = thresholdService.deleteDeviceThreshold(req.params.deviceId, operator);
      res.json({ success: true, data: { deleted: result }, message: '设备阈值删除成功' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
