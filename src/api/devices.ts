import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import { validateBody, validateQuery, validateParams, createDeviceSchema, updateDeviceSchema, deviceIdSchema, queryFiltersSchema } from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.post(
  '/',
  validateBody(createDeviceSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { deviceService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const device = deviceService.createDevice(req.body, operator);
      res.json({ success: true, data: device, message: '设备创建成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/:id',
  validateParams(deviceIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { deviceService } = services;
      const device = deviceService.getDevice(req.params.id);
      res.json({ success: true, data: device });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  validateQuery(queryFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { deviceService } = services;
      const result = deviceService.listDevices(req.query as any);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id',
  validateParams(deviceIdSchema),
  validateBody(updateDeviceSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { deviceService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const device = deviceService.updateDevice(req.params.id, req.body, operator);
      res.json({ success: true, data: device, message: '设备更新成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/:id/status',
  validateParams(deviceIdSchema),
  validateBody(updateDeviceSchema.pick({ status: true })),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { deviceService } = services;
      const operator = req.headers['x-user-id'] as string || 'admin';
      const device = deviceService.updateStatus(req.params.id, req.body.status, operator);
      res.json({ success: true, data: device, message: '设备状态更新成功' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
