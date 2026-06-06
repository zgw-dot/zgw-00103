import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ServiceContainer } from '../domain/services';
import { validateQuery, queryFiltersSchema } from '../validation';
import { ApiResponse } from '../types';
import { Readable } from 'stream';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

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
  validateQuery(queryFiltersSchema),
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
  async (req: Request, res: Response<ApiResponse>, next: NextFunction) => {
    try {
      const services = ServiceContainer.getInstanceSync();
      const { importBatchRepo } = services;
      const batch = importBatchRepo.findById(req.params.id);
      if (!batch) {
        return res.status(404).json({
          success: false,
          message: `导入批次"${req.params.id}"不存在`,
        });
      }
      res.json({ success: true, data: batch });
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
