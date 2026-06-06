import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import { validateBody, validateQuery, validateParams, alarmIdSchema, acknowledgeAlarmSchema, closeAlarmSchema, queryFiltersSchema } from '../validation';
import { ApiResponse, AlarmStatus } from '../types';

const router = Router();

router.get(
  '/:id',
  validateParams(alarmIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { alarmService, escalationService } = services;
      const alarm = alarmService.getAlarm(req.params.id);
      const enrichedAlarm = escalationService.enrichAlarmWithEscalation(alarm);
      res.json({ success: true, data: enrichedAlarm });
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
      const { alarmService, escalationService } = services;
      const result = alarmService.listAlarms(req.query as any);
      const enrichedItems = escalationService.enrichAlarmsWithEscalation(result.items);
      res.json({
        success: true,
        data: {
          ...result,
          items: enrichedItems,
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/stats/counts',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { alarmService } = services;
      const counts = {
        open: alarmService.countByStatus(AlarmStatus.OPEN),
        acknowledged: alarmService.countByStatus(AlarmStatus.ACKNOWLEDGED),
        recovered: alarmService.countByStatus(AlarmStatus.RECOVERED),
        closed: alarmService.countByStatus(AlarmStatus.CLOSED),
      };
      res.json({ success: true, data: counts });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/acknowledge',
  validateParams(alarmIdSchema),
  validateBody(acknowledgeAlarmSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { alarmService } = services;
      const { operator, note } = req.body;
      const alarm = alarmService.acknowledgeAlarm(req.params.id, operator, note);
      res.json({ success: true, data: alarm, message: '告警确认成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/close',
  validateParams(alarmIdSchema),
  validateBody(closeAlarmSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { alarmService } = services;
      const { operator, note } = req.body;
      const alarm = alarmService.closeAlarm(req.params.id, operator, note);
      res.json({ success: true, data: alarm, message: '告警关闭成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/device/:deviceId/open',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { alarmService } = services;
      const alarms = alarmService.getOpenAlarmsByDevice(req.params.deviceId);
      res.json({ success: true, data: alarms });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
