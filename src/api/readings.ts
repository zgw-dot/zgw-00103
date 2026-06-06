import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ServiceContainer } from '../domain/services';
import { validateQuery, validateBody, validateParams, queryFiltersSchema, batchQueryFiltersSchema, batchDetailSchema, upsertRemarkSchema, remarkRowParamSchema } from '../validation';
import { ApiResponse } from '../types';
import { Readable } from 'stream';
import { checkImportPermission, checkDryRunPermission, checkViewBatchesPermission, checkExportBatchesPermission } from '../domain/rules';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post(
  '/dry-run',
  upload.single('file'),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;

      const operator = (req.body.operator as string) || (req.headers['x-user-id'] as string) || 'admin';

      checkDryRunPermission(operator);

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请上传CSV文件',
        });
      }

      const fileStream = Readable.from(req.file.buffer);
      const result = await readingImportService.dryRunImport(
        fileStream,
        req.file.originalname,
        operator
      );

      res.json({
        success: true,
        data: result,
        message: `预检完成，共${result.totalCount}条，有效${result.validCount}条，无效${result.invalidCount}条`,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/import',
  upload.single('file'),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;

      const operator = (req.body.operator as string) || (req.headers['x-user-id'] as string) || 'admin';
      const idempotencyKey = (req.body.idempotencyKey as string) || (req.headers['x-idempotency-key'] as string) || undefined;

      checkImportPermission(operator);

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请上传CSV文件',
        });
      }

      const fileStream = Readable.from(req.file.buffer);
      const result = await readingImportService.importFromCsv(
        fileStream,
        req.file.originalname,
        operator,
        idempotencyKey
      );

      const statusCode = result.isIdempotencyHit ? 200 : 200;
      const hitMessage = result.isIdempotencyHit
        ? `幂等命中，返回原始批次(提交${result.submitCount}次)`
        : `导入成功，共${result.successCount}条`;

      res.status(statusCode).json({
        success: true,
        data: result,
        message: hitMessage,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/batches',
  validateQuery(batchQueryFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { importBatchRepo, batchRowRemarkRepo } = services;
      const operator = (req.headers['x-user-id'] as string) || 'admin';
      checkViewBatchesPermission(operator);
      const result = importBatchRepo.findAll(req.query as any);

      const itemsWithRemarkStats = result.items.map(batch => {
        const dataBatchId = (batch as any).originalBatchId || batch.id;
        const remarkStats = batchRowRemarkRepo.getRemarkStatsForBatch(dataBatchId);
        return { ...batch, remarkStats };
      });

      res.json({
        success: true,
        data: {
          ...result,
          items: itemsWithRemarkStats,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/batches/:batchId/rows/:rowIndex/remark',
  validateParams(remarkRowParamSchema),
  validateBody(upsertRemarkSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;
      const operator = (req.headers['x-user-id'] as string) || 'admin';
      const { batchId, rowIndex } = req.params as any;
      const { remarkContent } = req.body as any;

      const result = readingImportService.upsertRowRemark(
        batchId,
        parseInt(rowIndex, 10),
        remarkContent,
        operator
      );

      res.json({
        success: true,
        data: result,
        message: result.isClear
          ? '备注已清空'
          : result.isNew
            ? '备注已添加'
            : '备注已更新',
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/batches/:batchId/rows/:rowIndex/remark',
  validateParams(remarkRowParamSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;
      const operator = (req.headers['x-user-id'] as string) || 'admin';
      const { batchId, rowIndex } = req.params as any;

      const remark = readingImportService.getRowRemark(
        batchId,
        parseInt(rowIndex, 10),
        operator
      );

      res.json({ success: true, data: remark });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/batches/:id/export',
  validateQuery(batchDetailSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;
      const operator = (req.headers['x-user-id'] as string) || 'admin';
      const queryParams = req.query as any;
      const format = queryParams.format || 'json';

      const filters = {
        rowStatus: queryParams.rowStatus,
        page: queryParams.page,
        pageSize: queryParams.pageSize,
      };

      const { content, contentType, filename } = readingImportService.exportBatchDetail(
        req.params.id,
        format,
        operator,
        filters
      );

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/batches/:id',
  validateQuery(batchDetailSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingImportService } = services;
      const operator = (req.headers['x-user-id'] as string) || 'admin';
      const queryParams = req.query as any;
      const format = queryParams.format || 'json';

      const filters = {
        rowStatus: queryParams.rowStatus,
        page: queryParams.page,
        pageSize: queryParams.pageSize,
      };

      if (format === 'csv') {
        const { content, contentType, filename } = readingImportService.exportBatchDetail(
          req.params.id,
          'csv',
          operator,
          filters
        );
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      const detail = readingImportService.getBatchDetailWithRemarks(req.params.id, operator, filters);
      res.json({ success: true, data: detail });
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
      const { readingRepo } = services;
      const result = readingRepo.findAll(req.query as any);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/device/:deviceId',
  validateQuery(queryFiltersSchema),
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { readingRepo } = services;
      const result = readingRepo.findByDevice(req.params.deviceId, req.query as any);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
