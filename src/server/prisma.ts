import { PrismaClient } from '@prisma/client';
import net from 'node:net';
import { getSqliteQueueDb } from './sqliteQueue.ts';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function resolveMariaDbConfig(): {
  url: string | null;
  host: string;
  port: number;
  configured: boolean;
} {
  const directUrl = process.env.DATABASE_URL?.trim();
  if (directUrl && directUrl.startsWith('mysql://')) {
    try {
      const parsed = new URL(directUrl);
      return {
        url: directUrl,
        host: parsed.hostname || 'mariadb',
        port: Number(parsed.port || '3306'),
        configured: true,
      };
    } catch {
      return { url: null, host: 'mariadb', port: 3306, configured: false };
    }
  }

  const host = process.env.MARIADB_HOST?.trim() || 'mariadb';
  const port = Number(process.env.MARIADB_PORT?.trim() || '3306');
  const database = process.env.MARIADB_DATABASE?.trim() || 'pluviometro';
  const user = process.env.MARIADB_USER?.trim() || 'root';
  const password = process.env.MARIADB_PASSWORD;

  if (!password || password.length === 0) {
    return { url: null, host, port, configured: false };
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  const url = `mysql://${encodedUser}:${encodedPass}@${host}:${port}/${database}`;
  process.env.DATABASE_URL = url;
  return { url, host, port, configured: true };
}

function checkTcpReachable(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

const mariaDbConfig = resolveMariaDbConfig();
const fallbackDummyUrl = 'mysql://root:placeholder@mariadb:3306/pluviometro';

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: mariaDbConfig.url ?? fallbackDummyUrl,
      },
    },
    // Suppress raw Prisma stderr banners; errors are handled and logged cleanly by our server layer
    log: [],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

let mariaDbConnected = false;
let tablesVerified = false;
let lastConnectionError: string | null = null;
let lastProbeTimestamp = 0;
const RETRY_COOLDOWN_MS = 30_000;

export function isMariaDbConfigured(): boolean {
  return resolveMariaDbConfig().configured;
}

export function isMariaDbConnected(): boolean {
  return mariaDbConnected;
}

export function getLastMariaDbError(): string | null {
  return lastConnectionError;
}

export async function ensureMariaDbTables(): Promise<void> {
  if (tablesVerified) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`StationConfig\` (
      \`id\` VARCHAR(64) NOT NULL DEFAULT 'default',
      \`name\` VARCHAR(120) NOT NULL DEFAULT 'Estação Principal',
      \`location\` VARCHAR(160) NOT NULL DEFAULT 'Jardim / Ponto 01',
      \`mmPerPulse\` DOUBLE NOT NULL DEFAULT 0.25,
      \`timezone\` VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
      \`ingestKeyHash\` VARCHAR(255) NULL,
      \`ingestKeyHint\` VARCHAR(64) NULL,
      \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`AdminUser\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`username\` VARCHAR(64) NOT NULL,
      \`displayName\` VARCHAR(120) NOT NULL,
      \`passwordHash\` VARCHAR(255) NOT NULL,
      \`role\` VARCHAR(32) NOT NULL DEFAULT 'admin',
      \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`AdminUser_username_key\` (\`username\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`AuthSession\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`tokenHash\` VARCHAR(64) NOT NULL,
      \`userId\` INT NULL,
      \`username\` VARCHAR(64) NOT NULL,
      \`role\` VARCHAR(32) NOT NULL DEFAULT 'admin',
      \`expiresAt\` DATETIME(3) NOT NULL,
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`AuthSession_tokenHash_key\` (\`tokenHash\`),
      KEY \`AuthSession_expiresAt_idx\` (\`expiresAt\`),
      KEY \`AuthSession_userId_idx\` (\`userId\`),
      CONSTRAINT \`AuthSession_userId_fkey\`
        FOREIGN KEY (\`userId\`) REFERENCES \`AdminUser\` (\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`RainPulse\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`stationId\` VARCHAR(64) NOT NULL DEFAULT 'default',
      \`eventUid\` VARCHAR(128) NOT NULL,
      \`mm\` DOUBLE NOT NULL,
      \`timestampUnix\` INT NOT NULL,
      \`eventAt\` DATETIME(3) NOT NULL,
      \`queuedAt\` DATETIME(3) NULL,
      \`source\` VARCHAR(32) NOT NULL DEFAULT 'raspberry',
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`RainPulse_eventUid_key\` (\`eventUid\`),
      KEY \`RainPulse_eventAt_idx\` (\`eventAt\`),
      KEY \`RainPulse_stationId_eventAt_idx\` (\`stationId\`, \`eventAt\`),
      KEY \`RainPulse_timestampUnix_idx\` (\`timestampUnix\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`HourlySummary\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`stationId\` VARCHAR(64) NOT NULL DEFAULT 'default',
      \`hourKey\` VARCHAR(32) NOT NULL,
      \`hourStart\` DATETIME(3) NOT NULL,
      \`totalMm\` DOUBLE NOT NULL DEFAULT 0,
      \`pulseCount\` INT NOT NULL DEFAULT 0,
      \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`HourlySummary_hourKey_key\` (\`hourKey\`),
      KEY \`HourlySummary_hourStart_idx\` (\`hourStart\`),
      KEY \`HourlySummary_stationId_hourStart_idx\` (\`stationId\`, \`hourStart\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`DailySummary\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`stationId\` VARCHAR(64) NOT NULL DEFAULT 'default',
      \`dayKey\` VARCHAR(16) NOT NULL,
      \`dayStart\` DATETIME(3) NOT NULL,
      \`totalMm\` DOUBLE NOT NULL DEFAULT 0,
      \`pulseCount\` INT NOT NULL DEFAULT 0,
      \`peakIntensityMm\` DOUBLE NOT NULL DEFAULT 0,
      \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`DailySummary_dayKey_key\` (\`dayKey\`),
      KEY \`DailySummary_dayStart_idx\` (\`dayStart\`),
      KEY \`DailySummary_stationId_dayStart_idx\` (\`stationId\`, \`dayStart\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await prisma.stationConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      name: 'Estação Principal',
      location: 'Ponto Meteorológico 01',
      mmPerPulse: 0.25,
      timezone: process.env.TZ_STATION || 'America/Sao_Paulo',
    },
  });

  tablesVerified = true;
}

export async function ensureDatabaseReady(forceProbe = false): Promise<boolean> {
  // Initialize SQLite queue immediately regardless of MariaDB availability
  getSqliteQueueDb();

  const cfg = resolveMariaDbConfig();
  if (!cfg.configured) {
    mariaDbConnected = false;
    lastConnectionError =
      'Configure DATABASE_URL (mysql://...) ou MARIADB_PASSWORD nas variáveis de ambiente.';
    if (forceProbe || Date.now() - lastProbeTimestamp >= RETRY_COOLDOWN_MS) {
      lastProbeTimestamp = Date.now();
      console.warn(`[PluvioMonitor] ${lastConnectionError}`);
    }
    return false;
  }

  const now = Date.now();
  if (!forceProbe && !mariaDbConnected && now - lastProbeTimestamp < RETRY_COOLDOWN_MS) {
    return false;
  }
  lastProbeTimestamp = now;

  // Check TCP reachability before invoking Prisma to avoid spamming prisma:error on offline hosts
  const tcpOk = await checkTcpReachable(cfg.host, cfg.port, 1200);
  if (!tcpOk) {
    mariaDbConnected = false;
    lastConnectionError = `Host MariaDB (${cfg.host}:${cfg.port}) inacessível na rede atual.`;
    console.warn(`[PluvioMonitor] ${lastConnectionError}`);
    return false;
  }

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    await ensureMariaDbTables();
    mariaDbConnected = true;
    lastConnectionError = null;
    return true;
  } catch (err) {
    mariaDbConnected = false;
    lastConnectionError =
      err instanceof Error ? err.message.trim().split('\n')[0] : 'Falha de conexão ao MariaDB';
    console.warn(`[PluvioMonitor] Falha ao inicializar MariaDB: ${lastConnectionError}`);
    return false;
  }
}
