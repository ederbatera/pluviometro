import type { QueueStatsDto } from '../types/telemetry.ts';
import {
  ensureDatabaseReady,
  isMariaDbConnected,
  prisma,
} from './prisma.ts';
import {
  enqueueToSqlite,
  getSqliteQueueCount,
  markBatchFailedInSqlite,
  peekPendingFromSqlite,
  removeSyncedFromSqlite,
} from './sqliteQueue.ts';
import {
  getDayKey,
  getDayStartUtcForKey,
  getHourKey,
  getHourStartDate,
} from './timezone.ts';

export interface IncomingPulse {
  stationId?: string;
  eventUid?: string;
  mm: number;
  timestampUnix: number;
  queuedAt?: Date | null;
  source?: 'raspberry' | 'queue_replay' | 'simulator' | 'seed';
}

export interface IngestResult {
  received: number;
  queuedInSqlite: number;
  inserted: number;
  deduplicated: number;
  pendingInSqlite: number;
}

class AsyncPulseQueue {
  private flushInFlight: Promise<IngestResult> | null = null;
  private processedTotal = 0;
  private deduplicatedTotal = 0;
  private lastBatchAt: Date | null = null;
  private workerStarted = false;
  private persistListeners = new Set<() => void>();

  onPulsesPersisted(listener: () => void): () => void {
    this.persistListeners.add(listener);
    return () => {
      this.persistListeners.delete(listener);
    };
  }

  private emitPulsesPersisted(): void {
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[PulseQueue] Erro ao notificar ouvinte de persistência:', err);
      }
    }
  }

  startBackgroundWorker(): void {
    if (this.workerStarted) return;
    this.workerStarted = true;
    setInterval(() => {
      if (getSqliteQueueCount() > 0) {
        void this.flushPendingToMariaDb();
      }
    }, 10_000);
  }

  getStats(): QueueStatsDto {
    return {
      pendingInMemory: this.flushInFlight ? 1 : 0,
      pendingInSqlite: getSqliteQueueCount(),
      processedTotal: this.processedTotal,
      deduplicatedTotal: this.deduplicatedTotal,
      lastBatchAt: this.lastBatchAt ? this.lastBatchAt.toISOString() : null,
    };
  }

  async enqueue(pulses: IncomingPulse[]): Promise<IngestResult> {
    if (pulses.length === 0) {
      return {
        received: 0,
        queuedInSqlite: 0,
        inserted: 0,
        deduplicated: 0,
        pendingInSqlite: getSqliteQueueCount(),
      };
    }

    const sqliteInserted = enqueueToSqlite(
      pulses.map((p) => {
        const stationId = p.stationId || 'default';
        const eventUid = p.eventUid || `${stationId}:${p.timestampUnix}`;
        return {
          stationId,
          eventUid,
          mm: Number(p.mm.toFixed(4)),
          timestampUnix: p.timestampUnix,
          queuedAtUnix: p.queuedAt
            ? Math.floor(p.queuedAt.getTime() / 1000)
            : p.timestampUnix,
          source: p.source ?? 'raspberry',
        };
      }),
    );

    const flushRes = await this.flushPendingToMariaDb();
    return {
      received: pulses.length,
      queuedInSqlite: sqliteInserted,
      inserted: flushRes.inserted,
      deduplicated: flushRes.deduplicated,
      pendingInSqlite: getSqliteQueueCount(),
    };
  }

  enqueueFireAndForget(pulses: IncomingPulse[]): number {
    const queued = enqueueToSqlite(
      pulses.map((p) => {
        const stationId = p.stationId || 'default';
        const eventUid = p.eventUid || `${stationId}:${p.timestampUnix}`;
        return {
          stationId,
          eventUid,
          mm: Number(p.mm.toFixed(4)),
          timestampUnix: p.timestampUnix,
          queuedAtUnix: p.queuedAt
            ? Math.floor(p.queuedAt.getTime() / 1000)
            : p.timestampUnix,
          source: p.source ?? 'raspberry',
        };
      }),
    );
    void this.flushPendingToMariaDb();
    return queued;
  }

  async flushPendingToMariaDb(): Promise<IngestResult> {
    if (this.flushInFlight) {
      return this.flushInFlight;
    }

    this.flushInFlight = this.drainSqliteToMariaDb();
    try {
      return await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  private async drainSqliteToMariaDb(): Promise<IngestResult> {
    let totalInserted = 0;
    let totalDeduplicated = 0;

    if (!isMariaDbConnected()) {
      const ready = await ensureDatabaseReady();
      if (!ready) {
        return {
          received: 0,
          queuedInSqlite: 0,
          inserted: 0,
          deduplicated: 0,
          pendingInSqlite: getSqliteQueueCount(),
        };
      }
    }

    while (true) {
      const batch = peekPendingFromSqlite(200);
      if (batch.length === 0) break;

      const batchIds = batch.map((r) => r.id);

      try {
        const station = await prisma.stationConfig.findUnique({
          where: { id: 'default' },
          select: { timezone: true },
        });
        const timeZone =
          station?.timezone || process.env.TZ_STATION || 'America/Sao_Paulo';

        const uids = batch.map((r) => r.event_uid);

        const txResult = await prisma.$transaction(async (tx) => {
          const existingRows = await tx.rainPulse.findMany({
            where: { eventUid: { in: uids } },
            select: { eventUid: true },
          });
          const existingSet = new Set(existingRows.map((r) => r.eventUid));

          const fresh = batch.filter((r) => !existingSet.has(r.event_uid));
          if (fresh.length === 0) {
            return { inserted: 0, deduplicated: batch.length };
          }

          await tx.rainPulse.createMany({
            data: fresh.map((item) => ({
              stationId: item.station_id,
              eventUid: item.event_uid,
              mm: item.mm,
              timestampUnix: item.timestamp_unix,
              eventAt: new Date(item.timestamp_unix * 1000),
              queuedAt: new Date(item.queued_at_unix * 1000),
              source: item.source,
            })),
            skipDuplicates: true,
          });

          const hourlyIncrements = new Map<
            string,
            { stationId: string; hourStart: Date; totalMm: number; pulseCount: number }
          >();
          const dailyIncrements = new Map<
            string,
            { stationId: string; dayStart: Date; totalMm: number; pulseCount: number }
          >();

          for (const item of fresh) {
            const eventAt = new Date(item.timestamp_unix * 1000);
            const hKey = getHourKey(eventAt, timeZone);
            const existingHour = hourlyIncrements.get(hKey);
            if (existingHour) {
              existingHour.totalMm += item.mm;
              existingHour.pulseCount += 1;
            } else {
              hourlyIncrements.set(hKey, {
                stationId: item.station_id,
                hourStart: getHourStartDate(eventAt),
                totalMm: item.mm,
                pulseCount: 1,
              });
            }

            const dKey = getDayKey(eventAt, timeZone);
            const existingDay = dailyIncrements.get(dKey);
            if (existingDay) {
              existingDay.totalMm += item.mm;
              existingDay.pulseCount += 1;
            } else {
              dailyIncrements.set(dKey, {
                stationId: item.station_id,
                dayStart: getDayStartUtcForKey(dKey),
                totalMm: item.mm,
                pulseCount: 1,
              });
            }
          }

          for (const [hourKey, agg] of hourlyIncrements.entries()) {
            await tx.hourlySummary.upsert({
              where: { hourKey },
              create: {
                stationId: agg.stationId,
                hourKey,
                hourStart: agg.hourStart,
                totalMm: Number(agg.totalMm.toFixed(4)),
                pulseCount: agg.pulseCount,
              },
              update: {
                totalMm: { increment: Number(agg.totalMm.toFixed(4)) },
                pulseCount: { increment: agg.pulseCount },
              },
            });
          }

          for (const [dayKey, agg] of dailyIncrements.entries()) {
            await tx.dailySummary.upsert({
              where: { dayKey },
              create: {
                stationId: agg.stationId,
                dayKey,
                dayStart: agg.dayStart,
                totalMm: Number(agg.totalMm.toFixed(4)),
                pulseCount: agg.pulseCount,
                peakIntensityMm: Number(agg.totalMm.toFixed(2)),
              },
              update: {
                totalMm: { increment: Number(agg.totalMm.toFixed(4)) },
                pulseCount: { increment: agg.pulseCount },
              },
            });
          }

          return {
            inserted: fresh.length,
            deduplicated: batch.length - fresh.length,
          };
        });

        removeSyncedFromSqlite(batchIds);
        totalInserted += txResult.inserted;
        totalDeduplicated += txResult.deduplicated;
        this.processedTotal += txResult.inserted;
        this.deduplicatedTotal += txResult.deduplicated;
        this.lastBatchAt = new Date();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao drenar fila para MariaDB';
        markBatchFailedInSqlite(batchIds, msg);
        console.warn(`[PulseQueue] MariaDB indisponível, ${batchIds.length} pulso(s) mantidos na fila SQLite.`);
        break;
      }
    }

    if (totalInserted > 0) {
      this.emitPulsesPersisted();
    }

    return {
      received: 0,
      queuedInSqlite: 0,
      inserted: totalInserted,
      deduplicated: totalDeduplicated,
      pendingInSqlite: getSqliteQueueCount(),
    };
  }
}

export const pulseQueue = new AsyncPulseQueue();
