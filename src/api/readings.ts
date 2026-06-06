import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ServiceContainer } from '../domain/services';
import { validateQuery, validateBody, queryFiltersSchema, batchQueryFiltersSchema, batchDetailSchema } from '../validation';
import { ApiResponse } from '../types';
import { Readable } from 'stream';

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
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请上传CSV文件',
        });
      }

      const operator = (req.body.operator as string) || (req.headers['x-user-id'] as string) || 'admin';

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
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请上传CSV文件',
        });
      }

      const operator = (req.body.operator as string) || (req.headers['x-user-id'] as string) || 'admin';

      const fileStream = Readable.from(req.file.buffer);
      const result = await readingImportService.importFromCsv(
        fileStream,
        req.file.originalname,
        operator
      );

      const hasErrors = result.errors.length > 0;
      res.status(hasErrors ? 207 : 200).json({
        success: !hasErrors,
        data: result,
        message: hasErrors
          ? `导入完成，成功${result.successCount}条，失败${result.failedCount}条`
          : `导入成功，共${result.successCount}条`,
        errors: hasErrors ? result.errors : undefined,
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
      const { importBatchRepo } = services;
      const result = importBatchRepo.findAll(req.query as any);
      res.json({ success: true, data: result });
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
      const format = req.query.format as 'json' | 'csv' || 'json';

      if (format === 'csv') {
        const { content, contentType, filename } = readingImportService.exportBatchDetail(
          req.params.id,
          'csv',
          operator
        );
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      const detail = readingImportService.getBatchDetail(req.params.id, operator);
      res.json({ success: true, data: detail });
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
      const format = req.query.format as 'json' | 'csv' || 'json';

      const { content, contentType, filename } = readingImportService.exportBatchDetail(
        req.params.id,
        format,
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
