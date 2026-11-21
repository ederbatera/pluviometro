import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthStatusResponse, AuthUserDto } from '../types/telemetry.ts';
import {
  ensureDatabaseReady,
  isMariaDbConfigured,
  isMariaDbConnected,
  prisma,
} from './prisma.ts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUserDto;
  authToken?: string;
}

function getEnvAdminPassword(): string | null {
  const raw = process.env.ADMIN_PASSWORD?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPasswordScrypt(password: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function timingSafeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function getEnvSessionSecret(envPass: string): Buffer {
  return crypto
    .createHmac('sha256', envPass)
    .update('pluviometro-ema-env-session-v1')
    .digest();
}

function createEnvSignedToken(username: string, envPass: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      exp: Date.now() + SESSION_TTL_MS,
      n: crypto.randomBytes(8).toString('hex'),
    }),
    'utf8',
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getEnvSessionSecret(envPass))
    .update(payload)
    .digest('base64url');
  return `env.${payload}.${sig}`;
}

function verifyEnvSignedToken(rawToken: string, envPass: string): AuthUserDto | null {
  if (!rawToken.startsWith('env.')) return null;
  const parts = rawToken.split('.');
  if (parts.length !== 3) return null;
  const [, payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const expectedSig = crypto
    .createHmac('sha256', getEnvSessionSecret(envPass))
    .update(payloadB64)
    .digest('base64url');

  if (!timingSafeCompareStrings(sigB64, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      u?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp <= Date.now()) {
      return null;
    }
    return {
      username: parsed.u,
      displayName: 'Administrador',
      role: 'admin',
    };
  } catch {
    return null;
  }
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function ensureMariaDbAvailable(): Promise<boolean> {
  if (isMariaDbConnected()) return true;
  return ensureDatabaseReady();
}

export async function createSession(params: {
  userId: number | null;
  username: string;
  role: string;
}): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.authSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  await prisma.authSession.create({
    data: {
      id: crypto.randomUUID(),
      tokenHash,
      userId: params.userId,
      username: params.username,
      role: params.role,
      expiresAt,
    },
  });

  return rawToken;
}

export async function resolveSessionFromToken(rawToken: string | null): Promise<AuthUserDto | null> {
  if (!rawToken) return null;

  const envPass = getEnvAdminPassword();
  if (envPass && rawToken.startsWith('env.')) {
    return verifyEnvSignedToken(rawToken, envPass);
  }

  if (!(await ensureMariaDbAvailable())) {
    return null;
  }

  try {
    const tokenHash = hashSessionToken(rawToken);
    const session = await prisma.authSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            username: true,
            displayName: true,
            role: true,
          },
        },
      },
    });

    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }

    if (session.user) {
      return {
        username: session.user.username,
        displayName: session.user.displayName,
        role: session.user.role,
      };
    }

    return {
      username: session.username,
      displayName: 'Administrador',
      role: session.role,
    };
  } catch {
    return null;
  }
}

export async function resolveSession(req: Request): Promise<AuthUserDto | null> {
  return resolveSessionFromToken(extractBearerToken(req));
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearerToken(req);
  const envPass = getEnvAdminPassword();

  if (envPass && token?.startsWith('env.')) {
    const envUser = verifyEnvSignedToken(token, envPass);
    if (!envUser) {
      res.status(401).json({ erro: 'Autenticação necessária para acessar este recurso' });
      return;
    }
    req.authUser = envUser;
    req.authToken = token;
    next();
    return;
  }

  if (!(await ensureMariaDbAvailable())) {
    console.warn('[requireAuth] MariaDB indisponível para validar sessão.');
    res.status(503).json({
      erro: 'Serviço temporariamente indisponível.',
    });
    return;
  }

  const user = await resolveSessionFromToken(token);
  if (!user) {
    res.status(401).json({ erro: 'Autenticação necessária para acessar este recurso' });
    return;
  }
  req.authUser = user;
  req.authToken = token ?? undefined;
  next();
}

export async function getAuthStatus(req: Request): Promise<AuthStatusResponse> {
  const envPass = getEnvAdminPassword();
  const configured = isMariaDbConfigured();
  const connected = await ensureMariaDbAvailable();
  const user = await resolveSession(req);

  if (!connected) {
    return {
      authenticated: Boolean(user),
      setupRequired: false,
      authMode: envPass ? 'env' : 'database',
      mariadbConnected: false,
      mariadbConfigured: configured,
      user,
    };
  }

  if (envPass) {
    return {
      authenticated: Boolean(user),
      setupRequired: false,
      authMode: 'env',
      mariadbConnected: true,
      mariadbConfigured: configured,
      user,
    };
  }

  const adminCount = await prisma.adminUser.count();
  return {
    authenticated: Boolean(user),
    setupRequired: adminCount === 0,
    authMode: 'database',
    mariadbConnected: true,
    mariadbConfigured: configured,
    user,
  };
}

export async function setupInitialAdmin(params: {
  username: string;
  displayName: string;
  password: string;
}): Promise<{ token: string; user: AuthUserDto }> {
  if (getEnvAdminPassword()) {
    throw new Error('ENV_OVERRIDE');
  }

  if (!(await ensureMariaDbAvailable())) {
    throw new Error('MARIADB_UNAVAILABLE');
  }

  const normalizedUsername = params.username.trim().toLowerCase();
  const passwordHash = hashPasswordScrypt(params.password);

  const created = await prisma.$transaction(async (tx) => {
    const existingCount = await tx.adminUser.count();
    if (existingCount > 0) {
      throw new Error('ALREADY_CLAIMED');
    }

    return tx.adminUser.create({
      data: {
        username: normalizedUsername,
        displayName: params.displayName.trim(),
        passwordHash,
        role: 'admin',
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
      },
    });
  });

  const token = await createSession({
    userId: created.id,
    username: created.username,
    role: created.role,
  });

  return {
    token,
    user: {
      username: created.username,
      displayName: created.displayName,
      role: created.role,
    },
  };
}

export async function authenticateAdmin(params: {
  username: string;
  password: string;
}): Promise<{ token: string; user: AuthUserDto } | null> {
  const normalizedUsername = params.username.trim().toLowerCase();
  const envPass = getEnvAdminPassword();
  const mariaOk = await ensureMariaDbAvailable();

  if (envPass) {
    const expectedUsername = (process.env.ADMIN_USERNAME?.trim() || 'admin').toLowerCase();
    if (
      normalizedUsername === expectedUsername &&
      timingSafeCompareStrings(params.password, envPass)
    ) {
      const token = mariaOk
        ? await createSession({
            userId: null,
            username: expectedUsername,
            role: 'admin',
          })
        : createEnvSignedToken(expectedUsername, envPass);
      return {
        token,
        user: {
          username: expectedUsername,
          displayName: 'Administrador',
          role: 'admin',
        },
      };
    }
    return null;
  }

  if (!mariaOk) {
    throw new Error('MARIADB_UNAVAILABLE');
  }

  const admin = await prisma.adminUser.findUnique({
    where: { username: normalizedUsername },
  });

  if (!admin || !verifyPasswordScrypt(params.password, admin.passwordHash)) {
    return null;
  }

  const token = await createSession({
    userId: admin.id,
    username: admin.username,
    role: admin.role,
  });

  return {
    token,
    user: {
      username: admin.username,
      displayName: admin.displayName,
      role: admin.role,
    },
  };
}

export async function revokeSessionByToken(rawToken: string | null): Promise<void> {
  if (!rawToken || !isMariaDbConnected()) return;
  const tokenHash = hashSessionToken(rawToken);
  await prisma.authSession.deleteMany({
    where: { tokenHash },
  });
}
