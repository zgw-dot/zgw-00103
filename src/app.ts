import express from 'express';
import { config } from './config';
import logger from './utils/logger';
import { closeDatabase } from './storage/database';
import { devicesRouter, thresholdsRouter, alarmsRouter, readingsRouter, auditRouter } from './api';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { getTestUsers } from './domain/rules';
import { initServices } from './domain/services';

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  logger.info('Request', {
    method: req.method,
    path: req.path,
    userId: req.headers['x-user-id'],
  });
  res.setHeader('X-Powered-By', 'Cold-Chain-Alert-Service');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: Date.now(),
      version: '1.0.0',
    },
  });
});

app.get('/api/users', (req, res) => {
  res.json({
    success: true,
    data: getTestUsers(),
  });
});

app.use('/api/devices', devicesRouter);
app.use('/api/thresholds', thresholdsRouter);
app.use('/api/alarms', alarmsRouter);
app.use('/api/readings', readingsRouter);
app.use('/api/audit', auditRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  try {
    logger.info('Initializing database and services...');
    await initServices();
    logger.info('Services initialized successfully');

    const server = app.listen(config.port, () => {
      logger.info(`Server started on port ${config.port}`);
      logger.info('API Endpoints:');
      logger.info('  GET  /health');
      logger.info('  GET  /api/users');
      logger.info('  CRUD /api/devices');
      logger.info('  CRUD /api/thresholds');
      logger.info('  CRUD /api/alarms');
      logger.info('  POST /api/readings/import');
      logger.info('  GET  /api/readings');
      logger.info('  GET  /api/audit/logs');
      logger.info('  GET  /api/audit/export');
      logger.info('');
      logger.info('Test users (use X-User-Id header):');
      logger.info('  admin         - 全部权限');
      logger.info('  manager_zhang - 告警确认/关闭、导入、导出');
      logger.info('  operator_li   - 导入、导出');
      logger.info('  viewer_wang   - 导出');
    });

    const shutdown = () => {
      logger.info('Shutting down server...');
      server.close(() => {
        closeDatabase();
        logger.info('Server stopped');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return server;
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

export default app;
