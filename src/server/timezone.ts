export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayIndex: number; // 0 = Sunday .. 6 = Saturday
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const WEEKDAY_PT_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const rawHour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekdayIndex: WEEKDAY_MAP[map.weekday] ?? 0,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getHourKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}`;
}

export function getDayKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function getHourStartDate(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function getDayStartUtcForKey(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

export function formatHourLabel(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${pad2(p.hour)}:00`;
}

export function formatFullHourLabel(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${pad2(p.day)}/${pad2(p.month)} ${pad2(p.hour)}:00`;
}

export function formatDayShortLabel(dayKey: string, timeZone: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const p = getZonedParts(ref, timeZone);
  const wd = WEEKDAY_PT_SHORT[p.weekdayIndex] ?? '';
  return `${wd} ${pad2(d)}/${pad2(m)}`;
}

export function formatDayNumericLabel(dayKey: string): string {
  const [, m, d] = dayKey.split('-');
  return `${d}/${m}`;
}

export function formatFullDatePt(dayKey: string): string {
  const [y, m, d] = dayKey.split('-');
  return `${d}/${m}/${y}`;
}

export function getMondayDayKeyOfCurrentWeek(now: Date, timeZone: string): string {
  const p = getZonedParts(now, timeZone);
  const daysSinceMonday = p.weekdayIndex === 0 ? 6 : p.weekdayIndex - 1;
  const ref = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  ref.setUTCDate(ref.getUTCDate() - daysSinceMonday);
  return `${ref.getUTCFullYear()}-${pad2(ref.getUTCMonth() + 1)}-${pad2(ref.getUTCDate())}`;
}

export function getFirstDayKeyOfCurrentMonth(now: Date, timeZone: string): string {
  const p = getZonedParts(now, timeZone);
  return `${p.year}-${pad2(p.month)}-01`;
}

export function getPastDayKeys(now: Date, count: number, timeZone: string): string[] {
  const p = getZonedParts(now, timeZone);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return keys;
}

export function getCurrentMonthDayKeysUpToToday(now: Date, timeZone: string): string[] {
  const p = getZonedParts(now, timeZone);
  const keys: string[] = [];
  for (let day = 1; day <= p.day; day++) {
    keys.push(`${p.year}-${pad2(p.month)}-${pad2(day)}`);
  }
  return keys;
}
