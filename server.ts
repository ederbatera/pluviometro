import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDatabaseReady } from './src/server/prisma.ts';
import { pulseQueue } from './src/server/pulseQueue.ts';
import { realtimeHub } from './src/server/realtimeHub.ts';
import { apiRouter } from './src/server/routes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  await ensureDatabaseReady();
  pulseQueue.onPulsesPersisted(() => {
    void realtimeHub.notifyTelemetryChanged();
  });
  pulseQueue.startBackgroundWorker();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', apiRouter);

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  realtimeHub.attach(httpServer);

  const port = isProd ? Number(process.env.PORT || 3000) : 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[PluvioMonitor] Servidor HTTP/WS ativo em http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('[PluvioMonitor] Erro fatal na inicialização:', err);
  process.exit(1);
});
