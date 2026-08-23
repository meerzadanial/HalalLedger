import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { initializeDatabase, closeDatabase, getDatabaseClient } from './database';
import {
  ReportReadinessService,
  loadReportOperationalConfig,
} from './reporting';
import authRoutes from './routes/auth';
import incomeRoutes from './routes/income';
import analyticsRoutes from './routes/analytics';
import reportRoutes from './routes/reports';
import resendWebhookRoutes from './routes/resendWebhook';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const reportOperationalConfig = loadReportOperationalConfig();

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use('/api/webhooks/resend', resendWebhookRoutes);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Dependency readiness contains status names only, never configuration values.
app.get('/ready', async (_req, res) => {
  try {
    const readiness = await new ReportReadinessService(
      getDatabaseClient().getClient(),
      reportOperationalConfig,
    ).check();
    res.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  } catch {
    res.status(503).json({
      status: 'not_ready',
      checks: {
        database: 'failed',
        migrations: 'failed',
        provider: reportOperationalConfig.provider.configured ? 'ok' : 'failed',
        workerHeartbeat: 'failed',
      },
      checkedAt: new Date().toISOString(),
    });
  }
});

// API routes placeholder
app.get('/api', (_req, res) => {
  res.json({ message: 'HalalOrNot API Server' });
});

// Authentication routes
app.use('/api/auth', authRoutes);

// Income entry routes
app.use('/api/income-entries', incomeRoutes);

// Analytics routes
app.use('/api/analytics', analyticsRoutes);

// Authenticated report routes
app.use('/api', reportRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const server = app.listen(PORT, async () => {
  // eslint-disable-next-line no-console
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Initialize database connection
  try {
    await initializeDatabase();
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    console.log('HTTP server closed');
    await closeDatabase();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(async () => {
    console.log('HTTP server closed');
    await closeDatabase();
    process.exit(0);
  });
});

export default app;
