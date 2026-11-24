import crypto from 'node:crypto';
import { type NextFunction, Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  authenticateAdmin,
  extractBearerToken,
  getAuthStatus,
  requireAuth,
  resolveSession,
  revokeSessionByToken,
  setupInitialAdmin,
} from './auth.ts';
import {
  ensureDatabaseReady,
  getLastMariaDbError,
  isMariaDbConnected,
  prisma,
} from './prisma.ts';
import { type IncomingPulse, pulseQueue } from './pulseQueue.ts';
import { clearSqliteQueue, getSqliteQueueCount } from './sqliteQueue.ts';
import { realtimeHub } from './realtimeHub.ts';
import { getDashboardTelemetry } from './telemetryService.ts';

const singlePulseSchema = z.object({
  mm: z.coerce.number().finite().positive().max(50),
  timestamp: z.coerce.number().int().positive(),
  eventUid: z.string().trim().min(3).max(128).optional(),
  queuedAt: z.coerce.number().int().positive().optional(),
  stationId: z.string().trim().min(1).max(64).optional(),
  source: z.enum(['raspberry', 'queue_replay', 'simulator']).optional(),
});

const batchPulseSchema = z.object({
  pulses: z.array(singlePulseSchema).min(1).max(500),
});

const stationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(120),
  mmPerPulse: z.coerce.number().finite().min(0.05).max(5.0),
});

const demoPulseSchema = z.object({
  count: z.coerce.number().int().min(1).max(40).default(1),
  mode: z.enum(['live', 'queue_replay']).default('live'),
});

const setupAdminSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9._@-]+$/, 'Usuário deve conter apenas letras, números ou . _ @ -'),
  displayName: z.string().trim().min(2).max(80),
  password: z.string().min(6).max(128),
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

function timingSafeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashApiKeyScrypt(rawKey: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(rawKey, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyApiKeyScrypt(rawKey: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(rawKey, salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

async function verifyIngestionAuth(req: Request): Promise<boolean> {
  const providedKey =
    (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key']) ||
    (typeof req.headers['apikey'] === 'string' && req.headers['apikey']) ||
    '';

  if (!providedKey) {
    return false;
  }

  const envKey = process.env.INGEST_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    return timingSafeCompareStrings(providedKey, envKey);
  }

  if (isMariaDbConnected() || (await ensureDatabaseReady())) {
    const station = await prisma.stationConfig.findUnique({
      where: { id: 'default' },
      select: { ingestKeyHash: true },
    });

    if (station?.ingestKeyHash) {
      return verifyApiKeyScrypt(providedKey, station.ingestKeyHash);
    }
  }

  return false;
}

export const apiRouter = Router();

apiRouter.get('/health', async (_req: Request, res: Response) => {
  const mariaOk = isMariaDbConnected() || (await ensureDatabaseReady());
  const sqliteDepth = getSqliteQueueCount();
  res.json({
    status: mariaOk ? 'ok' : 'degraded',
    mariadb: mariaOk ? 'connected' : 'disconnected',
    sqliteQueue: 'ready',
    pendingInSqlite: sqliteDepth,
    detail: mariaOk ? null : getLastMariaDbError(),
    timestamp: new Date().toISOString(),
  });
});

// --- Auth Endpoints (MariaDB-backed AdminUser + AuthSession) ---
apiRouter.get('/auth/status', async (req: Request, res: Response) => {
  try {
    const status = await getAuthStatus(req);
    res.json(status);
  } catch (err) {
    console.error('[GET /api/auth/status]', err);
    res.status(500).json({ erro: 'Falha ao consultar status de autenticação' });
  }
});

apiRouter.post('/auth/setup', async (req: Request, res: Response) => {
  try {
    const parsed = setupAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        erro: 'Dados de cadastro inválidos. A senha deve ter pelo menos 6 caracteres.',
        detalhes: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await setupInitialAdmin(parsed.data);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && err.message === 'MARIADB_UNAVAILABLE') {
      console.error('[POST /api/auth/setup] MariaDB não conectado. Configure DATABASE_URL ou MARIADB_PASSWORD.');
      res.status(503).json({
        erro: 'Não foi possível concluir o cadastro no momento.',
      });
      return;
    }
    if (err instanceof Error && err.message === 'ENV_OVERRIDE') {
      console.warn('[POST /api/auth/setup] Tentativa de setup ignorada: login gerenciado por ADMIN_PASSWORD.');
      res.status(409).json({ erro: 'Operação indisponível neste ambiente.' });
      return;
    }
    if (err instanceof Error && err.message === 'ALREADY_CLAIMED') {
      res.status(409).json({ erro: 'Administrador inicial já foi configurado.' });
      return;
    }
    console.error('[POST /api/auth/setup]', err);
    res.status(500).json({ erro: 'Falha ao criar administrador inicial.' });
  }
});

apiRouter.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: 'Informe usuário e senha.' });
      return;
    }

    const result = await authenticateAdmin(parsed.data);
    if (!result) {
      res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
      return;
    }

    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === 'MARIADB_UNAVAILABLE') {
      console.error('[POST /api/auth/login] MariaDB indisponível. Verifique DATABASE_URL / MARIADB_PASSWORD.');
      res.status(503).json({
        erro: 'Não foi possível validar o acesso no momento. Tente novamente em instantes.',
      });
      return;
    }
    console.error('[POST /api/auth/login]', err);
    res.status(500).json({ erro: 'Falha ao autenticar usuário.' });
  }
});

apiRouter.post('/auth/logout', async (req: Request, res: Response) => {
  try {
    const token = extractBearerToken(req);
    await revokeSessionByToken(token);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[POST /api/auth/logout]', err);
    res.status(500).json({ erro: 'Falha ao encerrar sessão' });
  }
});

// Public dashboard summary + gated logs/station details when Bearer token is valid
apiRouter.get('/telemetry', async (req: Request, res: Response) => {
  try {
    const user = await resolveSession(req);
    const telemetry = await getDashboardTelemetry(Boolean(user));
    res.json(telemetry);
  } catch (err) {
    console.error('[GET /api/telemetry]', err);
    res.status(500).json({ erro: 'Falha ao carregar telemetria pluviométrica' });
  }
});

// Protected CSV export (Registros)
apiRouter.get('/pulses/export.csv', requireAuth, async (_req: Request, res: Response) => {
  try {
    if (!(isMariaDbConnected() || (await ensureDatabaseReady()))) {
      console.warn('[GET /api/pulses/export.csv] MariaDB indisponível.');
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return;
    }

    const rows = await prisma.rainPulse.findMany({
      orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
      take: 5000,
    });

    const header = 'id,event_uid,mm,timestamp_unix,event_at_iso,source\n';
    const lines = rows
      .map(
        (r) =>
          `${r.id},"${r.eventUid.replace(/"/g, '""')}",${r.mm},${r.timestampUnix},${r.eventAt.toISOString()},"${r.source}"`,
      )
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pluviometro_pulsos_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(header + lines);
  } catch (err) {
    console.error('[GET /api/pulses/export.csv]', err);
    res.status(500).json({ erro: 'Falha ao exportar CSV' });
  }
});

// Single pulse ingestion endpoint (buffered in SQLite queue, flushed asynchronously to MariaDB)
apiRouter.post('/pulses', async (req: Request, res: Response) => {
  try {
    const authorized = await verifyIngestionAuth(req);
    if (!authorized) {
      res.status(401).json({ erro: 'Chave de API ausente ou inválida' });
      return;
    }

    const parsed = singlePulseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        erro: 'Payload inválido',
        detalhes: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const item: IncomingPulse = {
      stationId: parsed.data.stationId || 'default',
      eventUid: parsed.data.eventUid,
      mm: parsed.data.mm,
      timestampUnix: parsed.data.timestamp,
      queuedAt: parsed.data.queuedAt ? new Date(parsed.data.queuedAt * 1000) : null,
      source: parsed.data.source ?? 'raspberry',
    };

    if (req.query.async === '1') {
      const queued = pulseQueue.enqueueFireAndForget([item]);
      res.status(202).json({
        status: 'enfileirado_sqlite',
        queuedInSqlite: queued,
        pendingInSqlite: getSqliteQueueCount(),
      });
      return;
    }

    const result = await pulseQueue.enqueue([item]);
    res.status(result.pendingInSqlite > 0 ? 202 : 200).json({
      status: result.pendingInSqlite > 0 ? 'enfileirado_sqlite' : 'sucesso',
      ...result,
      data_gravada: new Date(item.timestampUnix * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[POST /api/pulses]', err);
    res.status(500).json({ erro: 'Falha ao enfileirar pulso na fila SQLite' });
  }
});

// Batch pulse ingestion endpoint (buffered in SQLite queue, flushed asynchronously to MariaDB)
apiRouter.post('/pulses/batch', async (req: Request, res: Response) => {
  try {
    const authorized = await verifyIngestionAuth(req);
    if (!authorized) {
      res.status(401).json({ erro: 'Chave de API ausente ou inválida' });
      return;
    }

    const parsed = batchPulseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        erro: 'Lote de pulsos inválido',
        detalhes: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const items: IncomingPulse[] = parsed.data.pulses.map((p) => ({
      stationId: p.stationId || 'default',
      eventUid: p.eventUid,
      mm: p.mm,
      timestampUnix: p.timestamp,
      queuedAt: p.queuedAt ? new Date(p.queuedAt * 1000) : new Date(p.timestamp * 1000),
      source: p.source ?? 'queue_replay',
    }));

    if (req.query.async === '1') {
      const queued = pulseQueue.enqueueFireAndForget(items);
      res.status(202).json({
        status: 'enfileirado_sqlite',
        queuedInSqlite: queued,
        pendingInSqlite: getSqliteQueueCount(),
      });
      return;
    }

    const result = await pulseQueue.enqueue(items);
    res.status(result.pendingInSqlite > 0 ? 202 : 200).json({
      status: result.pendingInSqlite > 0 ? 'enfileirado_sqlite' : 'sucesso',
      ...result,
    });
  } catch (err) {
    console.error('[POST /api/pulses/batch]', err);
    res.status(500).json({ erro: 'Falha ao enfileirar lote na fila SQLite' });
  }
});

// Protected Station / Raspberry Pi Management Endpoints (MariaDB)
apiRouter.post('/station/ingest-key', requireAuth, async (_req: Request, res: Response) => {
  try {
    if (process.env.INGEST_API_KEY && process.env.INGEST_API_KEY.trim().length > 0) {
      res.status(409).json({
        erro: 'A chave de ingestão está definida via variável de ambiente INGEST_API_KEY no servidor.',
      });
      return;
    }

    if (!(isMariaDbConnected() || (await ensureDatabaseReady()))) {
      console.warn('[POST /api/station/ingest-key] MariaDB indisponível.');
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return;
    }

    const rawKey = `pluv_${crypto.randomBytes(24).toString('hex')}`;
    const ingestKeyHash = hashApiKeyScrypt(rawKey);
    const ingestKeyHint = `${rawKey.slice(0, 9)}...${rawKey.slice(-4)}`;

    await prisma.stationConfig.upsert({
      where: { id: 'default' },
      update: {
        ingestKeyHash,
        ingestKeyHint,
      },
      create: {
        id: 'default',
        name: 'Estação Principal',
        location: 'Ponto Meteorológico 01',
        mmPerPulse: 0.25,
        timezone: process.env.TZ_STATION || 'America/Sao_Paulo',
        ingestKeyHash,
        ingestKeyHint,
      },
    });

    res.status(200).json({
      apiKey: rawKey,
      hint: ingestKeyHint,
    });
  } catch (err) {
    console.error('[POST /api/station/ingest-key]', err);
    res.status(500).json({ erro: 'Falha ao gerar chave de API.' });
  }
});

apiRouter.patch('/station/config', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = stationUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: 'Configuração inválida' });
      return;
    }

    if (!(isMariaDbConnected() || (await ensureDatabaseReady()))) {
      console.warn('[PATCH /api/station/config] MariaDB indisponível.');
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return;
    }

    const updated = await prisma.stationConfig.upsert({
      where: { id: 'default' },
      update: {
        name: parsed.data.name,
        location: parsed.data.location,
        mmPerPulse: parsed.data.mmPerPulse,
      },
      create: {
        id: 'default',
        name: parsed.data.name,
        location: parsed.data.location,
        mmPerPulse: parsed.data.mmPerPulse,
        timezone: process.env.TZ_STATION || 'America/Sao_Paulo',
      },
      select: {
        id: true,
        name: true,
        location: true,
        mmPerPulse: true,
        timezone: true,
      },
    });

    void realtimeHub.notifyTelemetryChanged();
    res.json(updated);
  } catch (err) {
    console.error('[PATCH /api/station/config]', err);
    res.status(500).json({ erro: 'Falha ao salvar calibração.' });
  }
});

// Protected Demo / Simulation / Reset Endpoints
apiRouter.post('/demo/pulse', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = demoPulseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ erro: 'Parâmetros de simulação inválidos' });
      return;
    }

    let mmPerPulse = 0.25;
    if (isMariaDbConnected() || (await ensureDatabaseReady())) {
      const station = await prisma.stationConfig.findUnique({
        where: { id: 'default' },
        select: { mmPerPulse: true },
      });
      mmPerPulse = station?.mmPerPulse ?? 0.25;
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const pulses: IncomingPulse[] = [];

    for (let i = 0; i < parsed.data.count; i++) {
      const offsetSec =
        parsed.data.mode === 'queue_replay' ? (parsed.data.count - i) * 45 + 180 : i * 2;
      const ts = nowUnix - offsetSec;
      pulses.push({
        stationId: 'default',
        eventUid: `sim:${ts}:${crypto.randomUUID().slice(0, 8)}`,
        mm: mmPerPulse,
        timestampUnix: ts,
        queuedAt: new Date(ts * 1000),
        source: parsed.data.mode === 'queue_replay' ? 'queue_replay' : 'simulator',
      });
    }

    const result = await pulseQueue.enqueue(pulses);
    res.json({ status: 'sucesso', ...result });
  } catch (err) {
    console.error('[POST /api/demo/pulse]', err);
    res.status(500).json({ erro: 'Falha ao simular pulsos' });
  }
});

apiRouter.post('/demo/seed', requireAuth, async (_req: Request, res: Response) => {
  try {
    if (!(isMariaDbConnected() || (await ensureDatabaseReady()))) {
      console.warn('[POST /api/demo/seed] MariaDB indisponível.');
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return;
    }

    const station = await prisma.stationConfig.findUnique({
      where: { id: 'default' },
      select: { mmPerPulse: true },
    });
    const mmPerPulse = station?.mmPerPulse ?? 0.25;
    const nowUnix = Math.floor(Date.now() / 1000);

    const pulses: IncomingPulse[] = [];

    const dailyStormSpecs = [
      { daysAgo: 28, pulses: 18, peakHourOffset: 16 },
      { daysAgo: 25, pulses: 44, peakHourOffset: 18 },
      { daysAgo: 22, pulses: 12, peakHourOffset: 7 },
      { daysAgo: 19, pulses: 68, peakHourOffset: 15 },
      { daysAgo: 15, pulses: 24, peakHourOffset: 20 },
      { daysAgo: 12, pulses: 9, peakHourOffset: 6 },
      { daysAgo: 9, pulses: 52, peakHourOffset: 17 },
      { daysAgo: 6, pulses: 30, peakHourOffset: 14 },
      { daysAgo: 4, pulses: 14, peakHourOffset: 21 },
      { daysAgo: 2, pulses: 36, peakHourOffset: 16 },
      { daysAgo: 1, pulses: 22, peakHourOffset: 19 },
    ];

    for (const spec of dailyStormSpecs) {
      const baseDayUnix = nowUnix - spec.daysAgo * 86400;
      const dayMidnightOffset = baseDayUnix - (baseDayUnix % 86400);
      const stormCenter = dayMidnightOffset + spec.peakHourOffset * 3600;
      for (let i = 0; i < spec.pulses; i++) {
        const spread = Math.round(((i / spec.pulses) - 0.5) * 7200);
        const ts = stormCenter + spread;
        if (ts < nowUnix - 1800) {
          pulses.push({
            stationId: 'default',
            eventUid: `seed:${spec.daysAgo}:${i}:${ts}`,
            mm: mmPerPulse,
            timestampUnix: ts,
            queuedAt: new Date(ts * 1000),
            source: 'simulator',
          });
        }
      }
    }

    const recentOffsetsMinutes = [
      310, 295, 280, 240, 225, 195, 160, 148, 130, 108, 95, 82, 74, 63,
      54, 47, 39, 32, 24, 18, 12, 9, 6, 4, 2, 1,
    ];
    for (let i = 0; i < recentOffsetsMinutes.length; i++) {
      const ts = nowUnix - recentOffsetsMinutes[i] * 60;
      pulses.push({
        stationId: 'default',
        eventUid: `seed:recent:${i}:${ts}`,
        mm: mmPerPulse,
        timestampUnix: ts,
        queuedAt: new Date(ts * 1000),
        source: i % 5 === 0 ? 'queue_replay' : 'raspberry',
      });
    }

    const result = await pulseQueue.enqueue(pulses);
    res.json({ status: 'sucesso', ...result });
  } catch (err) {
    console.error('[POST /api/demo/seed]', err);
    res.status(500).json({ erro: 'Falha ao popular histórico de teste' });
  }
});

apiRouter.post('/demo/reset', requireAuth, async (_req: Request, res: Response) => {
  try {
    clearSqliteQueue();
    if (!(isMariaDbConnected() || (await ensureDatabaseReady()))) {
      console.warn('[POST /api/demo/reset] MariaDB indisponível; apenas fila local foi limpa.');
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return;
    }

    await prisma.$transaction([
      prisma.rainPulse.deleteMany(),
      prisma.hourlySummary.deleteMany(),
      prisma.dailySummary.deleteMany(),
    ]);
    void realtimeHub.notifyTelemetryChanged();
    res.json({ status: 'sucesso' });
  } catch (err) {
    console.error('[POST /api/demo/reset]', err);
    res.status(500).json({ erro: 'Falha ao limpar registros' });
  }
});

apiRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ erro: 'Endpoint da API não encontrado.' });
});

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]', err);
  if (!res.headersSent) {
    res.status(500).json({ erro: 'Erro interno ao processar requisição.' });
  }
});
