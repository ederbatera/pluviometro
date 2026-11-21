import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { TelemetryResponse } from '../types/telemetry.ts';
import { resolveSessionFromToken } from './auth.ts';
import { getDashboardTelemetry } from './telemetryService.ts';

interface ClientState {
  ws: WebSocket;
  isAuthenticated: boolean;
  isAlive: boolean;
}

class TelemetryRealtimeHub {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private decayTimer: NodeJS.Timeout | null = null;
  private broadcastRunning = false;
  private broadcastQueued = false;

  attach(httpServer: http.Server): void {
    if (this.wss) return;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    httpServer.on('upgrade', (request, socket, head) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }

      if (pathname !== '/ws/telemetry') {
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    wss.on('connection', (ws) => {
      const state: ClientState = {
        ws,
        isAuthenticated: false,
        isAlive: true,
      };
      this.clients.set(ws, state);

      ws.on('pong', () => {
        state.isAlive = true;
      });

      ws.on('message', (raw) => {
        void this.handleClientMessage(state, raw.toString());
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        if (this.clients.size === 0) {
          this.clearDecayTimer();
        }
      });

      ws.on('error', (err) => {
        console.warn('[RealtimeHub] Erro no socket do cliente:', err.message);
        this.clients.delete(ws);
        if (this.clients.size === 0) {
          this.clearDecayTimer();
        }
      });
    });

    // Heartbeat de transporte (sem consultas ao banco)
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, state] of this.clients.entries()) {
        if (!state.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        state.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
      if (this.clients.size === 0) {
        this.clearDecayTimer();
      }
    }, 30_000);
  }

  private clearDecayTimer(): void {
    if (this.decayTimer) {
      clearTimeout(this.decayTimer);
      this.decayTimer = null;
    }
  }

  private scheduleDecayIfRaining(telemetry: TelemetryResponse): void {
    this.clearDecayTimer();
    const isRainingNow =
      telemetry.intensity.mmPerHour > 0 || telemetry.intensity.mmPerHourInstant > 0;

    if (isRainingNow && this.clients.size > 0) {
      // Atualiza o decaimento da janela de 5/15 min apenas enquanto houver chuva recente ativa
      this.decayTimer = setTimeout(() => {
        void this.notifyTelemetryChanged();
      }, 60_000);
    }
  }

  private async handleClientMessage(state: ClientState, rawText: string): Promise<void> {
    try {
      const parsed = JSON.parse(rawText) as { type?: string; token?: unknown };
      if (parsed.type === 'auth') {
        const token = typeof parsed.token === 'string' && parsed.token.trim().length > 0
          ? parsed.token.trim()
          : null;
        const user = await resolveSessionFromToken(token);
        state.isAuthenticated = Boolean(user);

        if (state.ws.readyState === WebSocket.OPEN) {
          const snapshot = await getDashboardTelemetry(state.isAuthenticated);
          state.ws.send(JSON.stringify({ type: 'telemetry:update', data: snapshot }));
          this.scheduleDecayIfRaining(snapshot);
        }
      }
    } catch {
      // Ignora payloads malformados
    }
  }

  async notifyTelemetryChanged(): Promise<void> {
    if (this.clients.size === 0) {
      this.clearDecayTimer();
      return;
    }

    if (this.broadcastRunning) {
      this.broadcastQueued = true;
      return;
    }

    this.broadcastRunning = true;
    try {
      let anyAuth = false;
      for (const state of this.clients.values()) {
        if (state.ws.readyState === WebSocket.OPEN && state.isAuthenticated) {
          anyAuth = true;
          break;
        }
      }

      const publicTelemetry = await getDashboardTelemetry(false);
      const adminTelemetry = anyAuth ? await getDashboardTelemetry(true) : null;

      const publicPayload = JSON.stringify({
        type: 'telemetry:update',
        data: publicTelemetry,
      });
      const adminPayload = adminTelemetry
        ? JSON.stringify({
            type: 'telemetry:update',
            data: adminTelemetry,
          })
        : publicPayload;

      for (const state of this.clients.values()) {
        if (state.ws.readyState !== WebSocket.OPEN) continue;
        state.ws.send(state.isAuthenticated ? adminPayload : publicPayload);
      }

      this.scheduleDecayIfRaining(publicTelemetry);
    } catch (err) {
      console.error('[RealtimeHub] Falha ao transmitir atualização em tempo real:', err);
    } finally {
      this.broadcastRunning = false;
      if (this.broadcastQueued) {
        this.broadcastQueued = false;
        void this.notifyTelemetryChanged();
      }
    }
  }
}

export const realtimeHub = new TelemetryRealtimeHub();
