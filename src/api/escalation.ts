import { Router, Request, Response, NextFunction } from 'express';
import { ServiceContainer } from '../domain/services';
import {
  validateBody,
  validateQuery,
  validateParams,
  createEscalationRuleSchema,
  escalationRuleIdSchema,
  escalationTicketIdSchema,
  escalationTicketClaimSchema,
  escalationFiltersSchema,
  processOverdueSchema,
} from '../validation';
import { ApiResponse } from '../types';

const router = Router();

router.post(
  '/rules',
  validateBody(createEscalationRuleSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const { operator, ...ruleData } = req.body;
      const rule = escalationService.createRule(ruleData, operator);
      res.json({ success: true, data: rule, message: '升级规则创建成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/rules',
  validateQuery(escalationFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = escalationService.listRules(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/rules/:id',
  validateParams(escalationRuleIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const rule = escalationService.getRule(req.params.id);
      res.json({ success: true, data: rule });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/rules/:id/deactivate',
  validateParams(escalationRuleIdSchema),
  validateBody(escalationTicketClaimSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const { operator } = req.body;
      const rule = escalationService.deactivateRule(req.params.id, operator);
      res.json({ success: true, data: rule, message: '升级规则停用成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/rules/:id/revoke',
  validateParams(escalationRuleIdSchema),
  validateBody(escalationTicketClaimSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const { operator } = req.body;
      const rule = escalationService.revokeRule(req.params.id, operator);
      res.json({ success: true, data: rule, message: '升级规则撤销成功，历史升级记录已保留' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tickets',
  validateQuery(escalationFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = escalationService.listTickets(req.query as any, operator);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tickets/:id',
  validateParams(escalationTicketIdSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const ticket = escalationService.getTicket(req.params.id, operator);
      res.json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/tickets/:id/claim',
  validateParams(escalationTicketIdSchema),
  validateBody(escalationTicketClaimSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const { operator } = req.body;
      const ticket = escalationService.claimTicket(req.params.id, operator);
      res.json({ success: true, data: ticket, message: '升级单领取成功' });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/tickets/alarm/:alarmId',
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const ticket = escalationService.getTicketByAlarmId(req.params.alarmId, operator);
      res.json({ success: true, data: ticket });
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
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const counts = escalationService.getTicketStats(operator);
      res.json({ success: true, data: counts });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/export',
  validateQuery(escalationFiltersSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const operator = req.headers['x-user-id'] as string || 'viewer_wang';
      const result = escalationService.export(req.query as any, operator);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/process-overdue',
  validateBody(processOverdueSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { escalationService } = services;
      const { operator, currentTime } = req.body as { operator: string; currentTime?: number };
      const createdCount = escalationService.processOverdueAlarms(currentTime, operator);
      res.json({ success: true, data: { createdCount }, message: `已处理${createdCount}条超时告警` });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
