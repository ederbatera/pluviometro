import type {
  DailyPoint,
  HourlyPoint,
  IntensityStatus,
  RainClassification,
  TelemetryResponse,
  VelocityPoint,
} from '../types/telemetry.ts';
import {
  ensureDatabaseReady,
  isMariaDbConfigured,
  isMariaDbConnected,
  prisma,
} from './prisma.ts';
import { pulseQueue } from './pulseQueue.ts';
import {
  formatDayNumericLabel,
  formatDayShortLabel,
  formatFullDatePt,
  formatFullHourLabel,
  formatHourLabel,
  getCurrentMonthDayKeysUpToToday,
  getDayKey,
  getDayStartUtcForKey,
  getFirstDayKeyOfCurrentMonth,
  getHourKey,
  getHourStartDate,
  getMondayDayKeyOfCurrentWeek,
  getPastDayKeys,
  getZonedParts,
} from './timezone.ts';

function classifyRainIntensity(mmPerHour: number): {
  level: RainClassification;
  label: string;
} {
  if (mmPerHour <= 0) {
    return { level: 'dry', label: 'Sem chuva no momento' };
  }
  if (mmPerHour < 2.5) {
    return { level: 'light', label: 'Chuva Fraca' };
  }
  if (mmPerHour < 10) {
    return { level: 'moderate', label: 'Chuva Moderada' };
  }
  if (mmPerHour < 50) {
    return { level: 'heavy', label: 'Chuva Forte' };
  }
  return { level: 'torrential', label: 'Chuva Torrencial' };
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

export async function getDashboardTelemetry(
  isAuthenticated = false,
): Promise<TelemetryResponse> {
  const now = new Date();
  const timeZone = process.env.TZ_STATION || 'America/Sao_Paulo';

  const connected = isMariaDbConnected() || (await ensureDatabaseReady());
  const configured = isMariaDbConfigured();

  // Build empty calendar axes upfront so charts always render cleanly
  const hourKeys24: { key: string; date: Date }[] = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    hourKeys24.push({ key: getHourKey(d, timeZone), date: d });
  }
  const week7DayKeys = getPastDayKeys(now, 7, timeZone);
  const monthDayKeys = getCurrentMonthDayKeysUpToToday(now, timeZone);
  const rolling30DayKeys = getPastDayKeys(now, 30, timeZone);
  const monthKeysToRender = monthDayKeys.length >= 7 ? monthDayKeys : rolling30DayKeys;

  if (!connected) {
    const BUCKET_MINUTES = 10;
    const NUM_BUCKETS = 12;
    const nowBucketEndMs =
      Math.floor(now.getTime() / (BUCKET_MINUTES * 60 * 1000)) *
      (BUCKET_MINUTES * 60 * 1000);
    const emptyVelocity: VelocityPoint[] = [];
    for (let i = NUM_BUCKETS - 1; i >= 0; i--) {
      const bucketEnd = new Date(nowBucketEndMs - i * BUCKET_MINUTES * 60 * 1000);
      const parts = getZonedParts(bucketEnd, timeZone);
      const label = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
      emptyVelocity.push({ key: bucketEnd.toISOString(), label, mmPerHour: 0, mm: 0, pulses: 0 });
    }

    return {
      authenticated: isAuthenticated,
      mariadbConnected: false,
      mariadbConfigured: configured,
      generatedAt: now.toISOString(),
      station: {
        id: 'default',
        name: 'Estação Principal',
        location: 'Ponto Meteorológico 01',
        mmPerPulse: 0.25,
        timezone: timeZone,
        hasApiKeyConfigured: Boolean(process.env.INGEST_API_KEY?.trim()),
        apiKeyHint: null,
        keySource: 'unconfigured',
        lastPulseAt: null,
        totalPulsesAllTime: 0,
        totalMmAllTime: 0,
      },
      intensity: {
        level: 'dry',
        label: 'Sem chuva no momento',
        mmPerHour: 0,
        mmPerHourInstant: 0,
        pulsesLast15m: 0,
        pulsesLast60m: 0,
      },
      accumulated: {
        todayMm: 0,
        todayPulses: 0,
        last24hMm: 0,
        last24hPulses: 0,
        weekMm: 0,
        weekPulses: 0,
        monthMm: 0,
        monthPulses: 0,
        rainyDaysInWeek: 0,
        rainyDaysInMonth: 0,
        peakDailyMmMonth: 0,
        peakDailyLabelMonth: null,
      },
      series: {
        hourly24h: hourKeys24.map(({ key, date }) => ({
          key,
          label: formatHourLabel(date, timeZone),
          fullLabel: formatFullHourLabel(date, timeZone),
          mm: 0,
          pulses: 0,
          cumulativeMm: 0,
        })),
        weekly7d: week7DayKeys.map((dayKey) => ({
          key: dayKey,
          label: formatDayShortLabel(dayKey, timeZone),
          fullDate: formatFullDatePt(dayKey),
          mm: 0,
          pulses: 0,
          cumulativeMm: 0,
          peakIntensityMm: 0,
        })),
        monthly30d: monthKeysToRender.map((dayKey) => ({
          key: dayKey,
          label: formatDayNumericLabel(dayKey),
          fullDate: formatFullDatePt(dayKey),
          mm: 0,
          pulses: 0,
          cumulativeMm: 0,
          peakIntensityMm: 0,
        })),
        velocity2h: emptyVelocity,
      },
      recentPulses: [],
      queueStats: pulseQueue.getStats(),
    };
  }

  const stationConfig = await prisma.stationConfig.findUnique({
    where: { id: 'default' },
  });

  const activeTz = stationConfig?.timezone || timeZone;
  const todayKey = getDayKey(now, activeTz);
  const mondayKey = getMondayDayKeyOfCurrentWeek(now, activeTz);
  const monthStartKey = getFirstDayKeyOfCurrentMonth(now, activeTz);

  const minHourKey24 = hourKeys24[0].key;
  const earliestDailyKey = [
    mondayKey,
    monthStartKey,
    rolling30DayKeys[0],
  ].sort()[0];

  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000);
  const sixtyMinAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const [
    hourlyRows,
    dailyRows,
    recent2hPulses,
    latestPulses,
    allTimeAggregate,
    lastPulse,
  ] = await Promise.all([
    prisma.hourlySummary.findMany({
      where: {
        hourKey: { gte: minHourKey24 },
      },
      orderBy: { hourKey: 'asc' },
    }),
    prisma.dailySummary.findMany({
      where: {
        dayKey: { gte: earliestDailyKey },
      },
      orderBy: { dayKey: 'asc' },
    }),
    prisma.rainPulse.findMany({
      where: {
        eventAt: { gte: twoHoursAgo },
      },
      select: { mm: true, eventAt: true },
      orderBy: { eventAt: 'asc' },
    }),
    isAuthenticated
      ? prisma.rainPulse.findMany({
          orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
          take: 30,
        })
      : Promise.resolve([]),
    prisma.dailySummary.aggregate({
      _sum: { totalMm: true, pulseCount: true },
    }),
    prisma.rainPulse.findFirst({
      orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
      select: { eventAt: true },
    }),
  ]);

  // Intensity calculations from trailing 2h pulses
  let mm15m = 0;
  let pulses15m = 0;
  let mm5m = 0;
  let pulses60m = 0;

  for (const p of recent2hPulses) {
    if (p.eventAt >= sixtyMinAgo) {
      pulses60m += 1;
    }
    if (p.eventAt >= fifteenMinAgo) {
      mm15m += p.mm;
      pulses15m += 1;
    }
    if (p.eventAt >= fiveMinAgo) {
      mm5m += p.mm;
    }
  }

  const mmPerHour = round1(mm15m * 4);
  const mmPerHourInstant = round1(mm5m * 12);
  const classification = classifyRainIntensity(mmPerHour);

  const intensity: IntensityStatus = {
    level: classification.level,
    label: classification.label,
    mmPerHour,
    mmPerHourInstant,
    pulsesLast15m: pulses15m,
    pulsesLast60m: pulses60m,
  };

  // Hourly 24h series
  const hourlyMap = new Map(hourlyRows.map((h) => [h.hourKey, h]));
  let cumulative24h = 0;
  let last24hPulses = 0;
  const hourly24h: HourlyPoint[] = hourKeys24.map(({ key, date }) => {
    const row = hourlyMap.get(key);
    const mm = row ? round2(row.totalMm) : 0;
    const pulses = row ? row.pulseCount : 0;
    cumulative24h = round2(cumulative24h + mm);
    last24hPulses += pulses;
    return {
      key,
      label: formatHourLabel(date, activeTz),
      fullLabel: formatFullHourLabel(date, activeTz),
      mm,
      pulses,
      cumulativeMm: cumulative24h,
    };
  });

  // Daily lookup map
  const dailyMap = new Map(dailyRows.map((d) => [d.dayKey, d]));

  const todayRow = dailyMap.get(todayKey);
  const todayMm = round1(todayRow?.totalMm ?? 0);
  const todayPulses = todayRow?.pulseCount ?? 0;

  let weekMm = 0;
  let weekPulses = 0;
  let rainyDaysInWeek = 0;

  let monthMm = 0;
  let monthPulses = 0;
  let rainyDaysInMonth = 0;
  let peakDailyMmMonth = 0;
  let peakDailyLabelMonth: string | null = null;

  for (const row of dailyRows) {
    if (row.dayKey >= mondayKey && row.dayKey <= todayKey) {
      weekMm += row.totalMm;
      weekPulses += row.pulseCount;
      if (row.totalMm > 0) rainyDaysInWeek += 1;
    }
    if (row.dayKey >= monthStartKey && row.dayKey <= todayKey) {
      monthMm += row.totalMm;
      monthPulses += row.pulseCount;
      if (row.totalMm > 0) rainyDaysInMonth += 1;
      if (row.totalMm > peakDailyMmMonth) {
        peakDailyMmMonth = row.totalMm;
        peakDailyLabelMonth = formatFullDatePt(row.dayKey);
      }
    }
  }

  // Weekly 7-day rolling series
  let cumWeek = 0;
  const weekly7d: DailyPoint[] = week7DayKeys.map((dayKey) => {
    const row = dailyMap.get(dayKey);
    const mm = row ? round2(row.totalMm) : 0;
    cumWeek = round2(cumWeek + mm);
    return {
      key: dayKey,
      label: formatDayShortLabel(dayKey, activeTz),
      fullDate: formatFullDatePt(dayKey),
      mm,
      pulses: row?.pulseCount ?? 0,
      cumulativeMm: cumWeek,
      peakIntensityMm: row ? round1(row.peakIntensityMm) : 0,
    };
  });

  // Monthly series (current month days up to today, or trailing 30 days if early in month)
  let cumMonth = 0;
  const monthly30d: DailyPoint[] = monthKeysToRender.map((dayKey) => {
    const row = dailyMap.get(dayKey);
    const mm = row ? round2(row.totalMm) : 0;
    cumMonth = round2(cumMonth + mm);
    return {
      key: dayKey,
      label: formatDayNumericLabel(dayKey),
      fullDate: formatFullDatePt(dayKey),
      mm,
      pulses: row?.pulseCount ?? 0,
      cumulativeMm: cumMonth,
      peakIntensityMm: row ? round1(row.peakIntensityMm) : 0,
    };
  });

  // 2-hour Velocity series in 10-minute buckets (12 buckets)
  const BUCKET_MINUTES = 10;
  const NUM_BUCKETS = 12;
  const nowBucketEndMs =
    Math.floor(now.getTime() / (BUCKET_MINUTES * 60 * 1000)) *
    (BUCKET_MINUTES * 60 * 1000);

  const velocity2h: VelocityPoint[] = [];
  for (let i = NUM_BUCKETS - 1; i >= 0; i--) {
    const bucketStart = new Date(nowBucketEndMs - (i + 1) * BUCKET_MINUTES * 60 * 1000);
    const bucketEnd = new Date(nowBucketEndMs - i * BUCKET_MINUTES * 60 * 1000);
    let bucketMm = 0;
    let bucketPulses = 0;
    for (const p of recent2hPulses) {
      if (p.eventAt >= bucketStart && p.eventAt < bucketEnd) {
        bucketMm += p.mm;
        bucketPulses += 1;
      }
    }
    const parts = getZonedParts(bucketEnd, activeTz);
    const label = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    velocity2h.push({
      key: bucketEnd.toISOString(),
      label,
      mmPerHour: round1(bucketMm * (60 / BUCKET_MINUTES)),
      mm: round2(bucketMm),
      pulses: bucketPulses,
    });
  }

  const hasEnvKey = Boolean(process.env.INGEST_API_KEY && process.env.INGEST_API_KEY.trim().length > 0);
  const hasDbKey = Boolean(stationConfig?.ingestKeyHash);

  return {
    authenticated: isAuthenticated,
    mariadbConnected: true,
    mariadbConfigured: configured,
    generatedAt: now.toISOString(),
    station: {
      id: stationConfig?.id ?? 'default',
      name: stationConfig?.name ?? 'Estação Principal',
      location: stationConfig?.location ?? 'Ponto Meteorológico 01',
      mmPerPulse: stationConfig?.mmPerPulse ?? 0.25,
      timezone: activeTz,
      hasApiKeyConfigured: hasEnvKey || hasDbKey,
      apiKeyHint: isAuthenticated
        ? hasEnvKey
          ? 'Variável de ambiente INGEST_API_KEY'
          : stationConfig?.ingestKeyHint ?? null
        : null,
      keySource: isAuthenticated
        ? hasEnvKey
          ? 'env'
          : hasDbKey
            ? 'database'
            : 'unconfigured'
        : 'unconfigured',
      lastPulseAt: lastPulse ? lastPulse.eventAt.toISOString() : null,
      totalPulsesAllTime: allTimeAggregate._sum.pulseCount ?? 0,
      totalMmAllTime: round1(allTimeAggregate._sum.totalMm ?? 0),
    },
    intensity,
    accumulated: {
      todayMm,
      todayPulses,
      last24hMm: round1(cumulative24h),
      last24hPulses,
      weekMm: round1(weekMm),
      weekPulses,
      monthMm: round1(monthMm),
      monthPulses,
      rainyDaysInWeek,
      rainyDaysInMonth,
      peakDailyMmMonth: round1(peakDailyMmMonth),
      peakDailyLabelMonth,
    },
    series: {
      hourly24h,
      weekly7d,
      monthly30d,
      velocity2h,
    },
    recentPulses: latestPulses.map((p) => {
      const delaySeconds =
        p.queuedAt != null
          ? Math.max(0, Math.round((p.createdAt.getTime() - p.queuedAt.getTime()) / 1000))
          : Math.max(0, Math.round((p.createdAt.getTime() - p.eventAt.getTime()) / 1000));
      return {
        id: p.id,
        stationId: p.stationId,
        eventUid: p.eventUid,
        mm: p.mm,
        timestampUnix: p.timestampUnix,
        eventAt: p.eventAt.toISOString(),
        queuedAt: p.queuedAt ? p.queuedAt.toISOString() : null,
        source: p.source,
        delaySeconds,
      };
    }),
    queueStats: pulseQueue.getStats(),
  };
}

export interface DeletePulsesResult {
  deletedCount: number;
  affectedHours: number;
  affectedDays: number;
}

export async function deletePulsesAndRecompute(
  pulseIds: number[],
): Promise<DeletePulsesResult> {
  const uniqueIds = Array.from(
    new Set(pulseIds.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (uniqueIds.length === 0) {
    return { deletedCount: 0, affectedHours: 0, affectedDays: 0 };
  }

  const result = await prisma.$transaction(async (tx) => {
    const station = await tx.stationConfig.findUnique({
      where: { id: 'default' },
      select: { timezone: true },
    });
    const timeZone =
      station?.timezone || process.env.TZ_STATION || 'America/Sao_Paulo';

    const targets = await tx.rainPulse.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, eventAt: true },
    });

    if (targets.length === 0) {
      return { deletedCount: 0, affectedHours: 0, affectedDays: 0 };
    }

    const affectedHourKeys = new Set<string>();
    const affectedDayKeys = new Set<string>();
    let minEventMs = targets[0].eventAt.getTime();
    let maxEventMs = targets[0].eventAt.getTime();

    for (const target of targets) {
      const ms = target.eventAt.getTime();
      if (ms < minEventMs) minEventMs = ms;
      if (ms > maxEventMs) maxEventMs = ms;
      affectedHourKeys.add(getHourKey(target.eventAt, timeZone));
      affectedDayKeys.add(getDayKey(target.eventAt, timeZone));
    }

    const deleteRes = await tx.rainPulse.deleteMany({
      where: { id: { in: targets.map((t) => t.id) } },
    });

    // Fetch all remaining pulses in a safe UTC margin around affected days to recompute exact totals
    const windowStart = new Date(minEventMs - 36 * 3600 * 1000);
    const windowEnd = new Date(maxEventMs + 36 * 3600 * 1000);
    const remainingPulses = await tx.rainPulse.findMany({
      where: {
        eventAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        stationId: true,
        mm: true,
        eventAt: true,
      },
    });

    const hourlyAgg = new Map<
      string,
      { stationId: string; hourStart: Date; totalMm: number; pulseCount: number }
    >();
    const dailyAgg = new Map<
      string,
      { stationId: string; dayStart: Date; totalMm: number; pulseCount: number }
    >();

    for (const p of remainingPulses) {
      const hKey = getHourKey(p.eventAt, timeZone);
      const dKey = getDayKey(p.eventAt, timeZone);

      if (affectedHourKeys.has(hKey) || affectedDayKeys.has(dKey)) {
        const existingHour = hourlyAgg.get(hKey);
        if (existingHour) {
          existingHour.totalMm += p.mm;
          existingHour.pulseCount += 1;
        } else {
          hourlyAgg.set(hKey, {
            stationId: p.stationId,
            hourStart: getHourStartDate(p.eventAt),
            totalMm: p.mm,
            pulseCount: 1,
          });
        }
      }

      if (affectedDayKeys.has(dKey)) {
        const existingDay = dailyAgg.get(dKey);
        if (existingDay) {
          existingDay.totalMm += p.mm;
          existingDay.pulseCount += 1;
        } else {
          dailyAgg.set(dKey, {
            stationId: p.stationId,
            dayStart: getDayStartUtcForKey(dKey),
            totalMm: p.mm,
            pulseCount: 1,
          });
        }
      }
    }

    const peakByDay = new Map<string, number>();
    for (const [hKey, agg] of hourlyAgg.entries()) {
      const dKey = hKey.slice(0, 10);
      if (affectedDayKeys.has(dKey)) {
        const currentPeak = peakByDay.get(dKey) ?? 0;
        if (agg.totalMm > currentPeak) {
          peakByDay.set(dKey, agg.totalMm);
        }
      }
    }

    for (const hKey of affectedHourKeys) {
      const agg = hourlyAgg.get(hKey);
      if (!agg || agg.pulseCount === 0) {
        await tx.hourlySummary.deleteMany({ where: { hourKey: hKey } });
      } else {
        await tx.hourlySummary.upsert({
          where: { hourKey: hKey },
          create: {
            stationId: agg.stationId,
            hourKey: hKey,
            hourStart: agg.hourStart,
            totalMm: Number(agg.totalMm.toFixed(4)),
            pulseCount: agg.pulseCount,
          },
          update: {
            stationId: agg.stationId,
            totalMm: Number(agg.totalMm.toFixed(4)),
            pulseCount: agg.pulseCount,
          },
        });
      }
    }

    for (const dKey of affectedDayKeys) {
      const agg = dailyAgg.get(dKey);
      if (!agg || agg.pulseCount === 0) {
        await tx.dailySummary.deleteMany({ where: { dayKey: dKey } });
      } else {
        const peakIntensityMm = Number(
          (peakByDay.get(dKey) ?? agg.totalMm).toFixed(2),
        );
        await tx.dailySummary.upsert({
          where: { dayKey: dKey },
          create: {
            stationId: agg.stationId,
            dayKey: dKey,
            dayStart: agg.dayStart,
            totalMm: Number(agg.totalMm.toFixed(4)),
            pulseCount: agg.pulseCount,
            peakIntensityMm,
          },
          update: {
            stationId: agg.stationId,
            totalMm: Number(agg.totalMm.toFixed(4)),
            pulseCount: agg.pulseCount,
            peakIntensityMm,
          },
        });
      }
    }

    return {
      deletedCount: deleteRes.count,
      affectedHours: affectedHourKeys.size,
      affectedDays: affectedDayKeys.size,
    };
  });

  return result;
}
