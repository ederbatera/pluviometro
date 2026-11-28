import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Search, Trash2, X } from 'lucide-react';
import type { RecentPulseDto } from '../types/telemetry.ts';
import { formatDateTimePt, formatMm, formatSourceLabel } from '../utils/formatters.ts';

interface PulseLogTableProps {
  pulses: RecentPulseDto[];
  authToken: string;
  onPulsesChanged?: () => Promise<void> | void;
}

interface PulsesListResponse {
  pulses: RecentPulseDto[];
  total: number;
  limit: number;
  offset: number;
  erro?: string;
}

interface DeletePulsesResponse {
  status?: string;
  deletedCount?: number;
  affectedHours?: number;
  affectedDays?: number;
  erro?: string;
}

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function PulseLogTable({
  pulses,
  authToken,
  onPulsesChanged,
}: PulseLogTableProps) {
  const [sourceFilter, setSourceFilter] = useState<'all' | 'raspberry' | 'queue_replay' | 'simulator'>('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const [rows, setRows] = useState<RecentPulseDto[]>(pulses);
  const [totalCount, setTotalCount] = useState<number>(pulses.length);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const fetchPulsesPage = useCallback(
    async (limit = 100, offset = 0, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoadingList(true);
      }
      try {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });
        const res = await fetch(`/api/pulses?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
        });
        const data = await parseJsonSafe<PulsesListResponse>(res);
        if (!res.ok || !data || !Array.isArray(data.pulses)) {
          return;
        }
        setTotalCount(data.total);
        setRows((prev) => {
          if (!append) return data.pulses;
          const seen = new Set(prev.map((p) => p.id));
          const merged = [...prev];
          for (const item of data.pulses) {
            if (!seen.has(item.id)) {
              merged.push(item);
            }
          }
          return merged;
        });
      } catch (err) {
        console.error('[PulseLogTable] Falha ao buscar lista de pulsos:', err);
      } finally {
        setLoadingList(false);
        setLoadingMore(false);
      }
    },
    [authToken],
  );

  // Sincroniza quando a aba abre ou quando chegam novos pulsos ao vivo via WebSocket
  useEffect(() => {
    void fetchPulsesPage(Math.max(100, rows.length || 100), 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, pulses]);

  // Remove IDs selecionados que não estão mais presentes após atualização
  useEffect(() => {
    const validIds = new Set(rows.map((r) => r.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (sourceFilter !== 'all' && p.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        p.eventUid.toLowerCase().includes(q) ||
        (p.stationId ?? '').toLowerCase().includes(q) ||
        formatDateTimePt(p.eventAt).toLowerCase().includes(q) ||
        formatSourceLabel(p.source).toLowerCase().includes(q)
      );
    });
  }, [rows, sourceFilter, search]);

  const visibleSelectedCount = useMemo(
    () => filtered.filter((p) => selectedIds.has(p.id)).length,
    [filtered, selectedIds],
  );

  const allVisibleSelected =
    filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < filtered.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const selectedSummary = useMemo(() => {
    let count = 0;
    let totalMm = 0;
    for (const p of rows) {
      if (selectedIds.has(p.id)) {
        count += 1;
        totalMm += p.mm;
      }
    }
    return { count, totalMm };
  }, [rows, selectedIds]);

  const toggleSelectOne = (id: number) => {
    setFeedback(null);
    setConfirmingDelete(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setFeedback(null);
    setConfirmingDelete(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const p of filtered) {
          next.delete(p.id);
        }
      } else {
        for (const p of filtered) {
          next.add(p.id);
        }
      }
      return next;
    });
  };

  const handleRequestSingleDelete = (id: number) => {
    setFeedback(null);
    setSelectedIds(new Set([id]));
    setConfirmingDelete(true);
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setDeleting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/pulses/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({ ids }),
      });
      const data = await parseJsonSafe<DeletePulsesResponse>(res);
      if (!res.ok) {
        setFeedback({
          kind: 'error',
          text: data?.erro || 'Não foi possível excluir os pulsos selecionados.',
        });
        return;
      }

      const deletedCount = data?.deletedCount ?? ids.length;
      setSelectedIds(new Set());
      setConfirmingDelete(false);
      setFeedback({
        kind: 'success',
        text: `${deletedCount} pulso(s) removido(s) e acumulados recalculados com sucesso.`,
      });
      await fetchPulsesPage(Math.max(100, rows.length), 0, false);
      if (onPulsesChanged) {
        await onPulsesChanged();
      }
    } catch (err) {
      console.error('[PulseLogTable] Falha ao excluir pulsos:', err);
      setFeedback({
        kind: 'error',
        text: 'Erro de comunicação ao excluir pulsos.',
      });
    } finally {
      setDeleting(false);
    }
  };

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
            Registros de Pulsos ({totalCount})
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Selecione leituras falsas ou de teste para excluir e recalcular os acumulados automaticamente.
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

      {/* Barra de ação em lote quando há pulsos selecionados */}
      {selectedSummary.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200/80 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 px-5 py-3">
          <div className="text-xs font-medium text-rose-900 dark:text-rose-200">
            <span className="font-mono font-semibold">{selectedSummary.count}</span>{' '}
            pulso(s) selecionado(s) ·{' '}
            <span className="font-mono">{formatMm(selectedSummary.totalMm, 2)} mm</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedIds(new Set());
                    setConfirmingDelete(false);
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  Limpar seleção
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-medium text-white hover:bg-rose-500 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Excluir selecionados
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-rose-800 dark:text-rose-200">
                  Confirmar exclusão e recalcular acumulados?
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors whitespace-nowrap"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteSelected()}
                  disabled={deleting}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-60 transition-colors whitespace-nowrap"
                >
                  <Check className="h-3.5 w-3.5" />
                  {deleting ? 'Excluindo...' : 'Confirmar exclusão'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={`flex items-center justify-between gap-3 border-b px-5 py-2.5 text-xs ${
            feedback.kind === 'success'
              ? 'border-emerald-200/80 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-rose-200/80 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Fechar aviso"
            className="text-current opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loadingList && rows.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Carregando registros...
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Nenhum pulso encontrado para o filtro selecionado.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 pl-5 pr-2 w-10">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      aria-label="Selecionar todos os pulsos visíveis"
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 focus:ring-sky-500 cursor-pointer"
                    />
                  </th>
                  <th className="py-2.5 px-3">Data e Hora do Evento</th>
                  <th className="py-2.5 px-3">Estação</th>
                  <th className="py-2.5 px-3">Identificador (UID)</th>
                  <th className="py-2.5 px-3">Origem</th>
                  <th className="py-2.5 px-3 text-right">Atraso</th>
                  <th className="py-2.5 px-3 text-right">Volume (mm)</th>
                  <th className="py-2.5 pl-2 pr-5 text-right w-14">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-sm">
                {filtered.map((pulse) => {
                  const isSelected = selectedIds.has(pulse.id);
                  return (
                    <tr
                      key={pulse.id}
                      className={`h-10 transition-colors ${
                        isSelected
                          ? 'bg-rose-50/50 dark:bg-rose-950/20'
                          : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2 pl-5 pr-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectOne(pulse.id)}
                          aria-label={`Selecionar pulso ${pulse.eventUid}`}
                          className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-sky-600 focus:ring-sky-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-2 px-3 font-mono text-xs text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {formatDateTimePt(pulse.eventAt)}
                      </td>
                      <td className="py-2 px-3 font-mono text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {pulse.stationId ?? 'default'}
                      </td>
                      <td className="py-2 px-3 font-mono text-xs text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                        {pulse.eventUid}
                      </td>
                      <td className="py-2 px-3 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {formatSourceLabel(pulse.source)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {pulse.delaySeconds !== null ? `${pulse.delaySeconds}s` : '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-xs font-semibold text-sky-700 dark:text-sky-400 whitespace-nowrap">
                        +{formatMm(pulse.mm, 2)} mm
                      </td>
                      <td className="py-2 pl-2 pr-5 text-right">
                        <button
                          type="button"
                          onClick={() => handleRequestSingleDelete(pulse.id)}
                          title="Excluir este pulso"
                          aria-label={`Excluir pulso ${pulse.eventUid}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.length < totalCount && (
            <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 px-5 py-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Exibindo {rows.length} de {totalCount} registro(s)
              </span>
              <button
                type="button"
                onClick={() => void fetchPulsesPage(100, rows.length, true)}
                disabled={loadingMore}
                className="inline-flex h-8 items-center rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors"
              >
                {loadingMore ? 'Carregando...' : 'Carregar mais registros'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
