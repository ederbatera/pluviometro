export type RainClassification =
  | 'dry'
  | 'light'
  | 'moderate'
  | 'heavy'
  | 'torrential';

export interface IntensityStatus {
  level: RainClassification;
  label: string;
  mmPerHour: number;
  mmPerHourInstant: number;
  pulsesLast15m: number;
  pulsesLast60m: number;
}

export interface AccumulatedMetrics {
  todayMm: number;
  todayPulses: number;
  last24hMm: number;
  last24hPulses: number;
  weekMm: number;
  weekPulses: number;
  monthMm: number;
  monthPulses: number;
  rainyDaysInWeek: number;
  rainyDaysInMonth: number;
  peakDailyMmMonth: number;
  peakDailyLabelMonth: string | null;
}

export interface HourlyPoint {
  key: string;
  label: string;
  fullLabel: string;
  mm: number;
  pulses: number;
  cumulativeMm: number;
}

export interface DailyPoint {
  key: string;
  label: string;
  fullDate: string;
  mm: number;
  pulses: number;
  cumulativeMm: number;
  peakIntensityMm: number;
}

export interface VelocityPoint {
  key: string;
  label: string;
  mmPerHour: number;
  mm: number;
  pulses: number;
}

export interface RecentPulseDto {
  id: number;
  stationId?: string;
  eventUid: string;
  mm: number;
  timestampUnix: number;
  eventAt: string;
  queuedAt: string | null;
  source: string;
  delaySeconds: number | null;
}

export interface StationInfoDto {
  id: string;
  name: string;
  location: string;
  mmPerPulse: number;
  timezone: string;
  hasApiKeyConfigured: boolean;
  apiKeyHint: string | null;
  keySource: 'env' | 'database' | 'unconfigured';
  lastPulseAt: string | null;
  totalPulsesAllTime: number;
  totalMmAllTime: number;
}

export interface QueueStatsDto {
  pendingInMemory: number;
  pendingInSqlite: number;
  processedTotal: number;
  deduplicatedTotal: number;
  lastBatchAt: string | null;
}

export interface AuthUserDto {
  username: string;
  displayName: string;
  role: string;
}

export interface AuthStatusResponse {
  authenticated: boolean;
  setupRequired: boolean;
  authMode: 'env' | 'database';
  mariadbConnected: boolean;
  mariadbConfigured: boolean;
  user: AuthUserDto | null;
}

export interface TelemetryResponse {
  authenticated: boolean;
  mariadbConnected: boolean;
  mariadbConfigured: boolean;
  generatedAt: string;
  station: StationInfoDto;
  intensity: IntensityStatus;
  accumulated: AccumulatedMetrics;
  series: {
    hourly24h: HourlyPoint[];
    weekly7d: DailyPoint[];
    monthly30d: DailyPoint[];
    velocity2h: VelocityPoint[];
  };
  recentPulses: RecentPulseDto[];
  queueStats: QueueStatsDto;
}
