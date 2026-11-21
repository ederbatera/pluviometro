import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import type { RecentPulseDto } from '../types/telemetry.ts';
import { formatDateTimePt, formatMm, formatSourceLabel } from '../utils/formatters.ts';

interface PulseLogTableProps {
  pulses: RecentPulseDto[];
  authToken: string;
}

export function PulseLogTable({ pulses, authToken }: PulseLogTableProps) {
  const [sourceFilter, setSourceFilter] = useState<'all' | 'raspberry' | 'queue_replay' | 'simulator'>('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pulses.filter((p) => {
      if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        p.eventUid.toLowerCase().includes(q) ||
        formatDateTimePt(p.eventAt).toLowerCase().includes(q) ||
        formatSourceLabel(p.source).toLowerCase().includes(q)
      );
    });
  }, [pulses, sourceFilter, search]);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/pulses/export.csv', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pluviometro_pulsos_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Registros Recentes de Pulsos
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Últimas 30 basculadas persistidas no Prisma com controle de idempotência e latência de fila.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtrar UID ou horário..."
              aria-label="Filtrar registros"
              className="h-9 w-48 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-900 p-1">
            {(
              [
                ['all', 'Todos'],
                ['raspberry', 'Raspberry'],
                ['queue_replay', 'Fila Offline'],
                ['simulator', 'Simulador'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSourceFilter(key)}
                className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  sourceFilter === key
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleExportCsv()}
            disabled={exporting}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exportando...' : 'Exportar CSV'}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Nenhum pulso encontrado para o filtro selecionado.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-5">Data e Hora do Evento</th>
                <th className="py-2.5 px-4">Identificador (UID)</th>
                <th className="py-2.5 px-4">Origem</th>
                <th className="py-2.5 px-4 text-right">Atraso de Sincronia</th>
                <th className="py-2.5 px-5 text-right">Volume (mm)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-sm">
              {filtered.map((pulse) => (
                <tr
                  key={pulse.id}
                  className="h-10 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <td className="py-2 px-5 font-mono text-xs text-slate-800 dark:text-slate-200 whitespace-nowrap">
                    {formatDateTimePt(pulse.eventAt)}
                  </td>
                  <td className="py-2 px-4 font-mono text-xs text-slate-500 dark:text-slate-400 truncate max-w-[220px]">
                    {pulse.eventUid}
                  </td>
                  <td className="py-2 px-4 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {formatSourceLabel(pulse.source)}
                  </td>
                  <td className="py-2 px-4 text-right font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {pulse.delaySeconds !== null ? `${pulse.delaySeconds}s` : '—'}
                  </td>
                  <td className="py-2 px-5 text-right font-mono text-xs font-semibold text-sky-700 dark:text-sky-400 whitespace-nowrap">
                    +{formatMm(pulse.mm, 2)} mm
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
