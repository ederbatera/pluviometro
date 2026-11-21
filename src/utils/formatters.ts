import type { RainClassification } from '../types/telemetry.ts';

export function formatMm(value: number, decimals = 1): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatInteger(value: number): string {
  return value.toLocaleString('pt-BR');
}

export function formatDateTimePt(isoString: string | null): string {
  if (!isoString) return 'Sem registros';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Sem registros';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRelativeTimePt(isoString: string | null): string {
  if (!isoString) return 'aguardando pulso';
  const ts = new Date(isoString).getTime();
  if (Number.isNaN(ts)) return 'aguardando pulso';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 15) return 'agora mesmo';
  if (diffSec < 60) return `há ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `há ${diffDays}d`;
}

export function getIntensityMeta(level: RainClassification): {
  textClass: string;
  barClass: string;
  glyph: string;
  description: string;
} {
  switch (level) {
    case 'light':
      return {
        textClass: 'text-sky-600 dark:text-sky-400',
        barClass: 'bg-sky-500',
        glyph: '◔',
        description: '0,1 a 2,4 mm/h',
      };
    case 'moderate':
      return {
        textClass: 'text-blue-600 dark:text-blue-400',
        barClass: 'bg-blue-600',
        glyph: '◑',
        description: '2,5 a 9,9 mm/h',
      };
    case 'heavy':
      return {
        textClass: 'text-amber-600 dark:text-amber-400',
        barClass: 'bg-amber-500',
        glyph: '◕',
        description: '10,0 a 49,9 mm/h',
      };
    case 'torrential':
      return {
        textClass: 'text-rose-600 dark:text-rose-400',
        barClass: 'bg-rose-600',
        glyph: '◉',
        description: '≥ 50,0 mm/h',
      };
    case 'dry':
    default:
      return {
        textClass: 'text-slate-500 dark:text-slate-400',
        barClass: 'bg-slate-300 dark:bg-slate-700',
        glyph: '○',
        description: '0,0 mm/h',
      };
  }
}

export function formatSourceLabel(source: string): string {
  switch (source) {
    case 'raspberry':
      return 'Raspberry Pi';
    case 'queue_replay':
      return 'Fila Offline';
    case 'simulator':
      return 'Simulador';
    default:
      return source;
  }
}
