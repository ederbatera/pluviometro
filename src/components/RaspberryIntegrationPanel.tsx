import { useState } from 'react';
import { Check, Copy, Download, KeyRound, Play, Save, Send, WifiOff } from 'lucide-react';
import {
  PRISMA_SCHEMA_PREVIEW,
  RASPBERRY_API_SCRIPT,
  RASPBERRY_DIRECT_DB_SCRIPT,
} from '../data/raspberryScripts.ts';
import type { StationInfoDto } from '../types/telemetry.ts';
import { formatMm } from '../utils/formatters.ts';

interface RaspberryIntegrationPanelProps {
  station: StationInfoDto;
  authToken: string;
  onRefresh: () => Promise<void>;
}

interface OfflineQueuedItem {
  eventUid: string;
  mm: number;
  timestamp: number;
  queuedAt: number;
}

export function RaspberryIntegrationPanel({
  station,
  authToken,
  onRefresh,
}: RaspberryIntegrationPanelProps) {
  const [activeCodeTab, setActiveCodeTab] = useState<'api' | 'direct' | 'prisma'>('api');
  const [copied, setCopied] = useState(false);

  // Station calibration state
  const [name, setName] = useState(station.name);
  const [location, setLocation] = useState(station.location);
  const [mmPerPulse, setMmPerPulse] = useState(String(station.mmPerPulse));
  const [savingConfig, setSavingConfig] = useState(false);
  const [configNotice, setConfigNotice] = useState<string | null>(null);

  // Ingestion API key generation state
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Interactive offline queue simulator
  const [localQueue, setLocalQueue] = useState<OfflineQueuedItem[]>([]);
  const [flushingQueue, setFlushingQueue] = useState(false);
  const [queueFeedback, setQueueFeedback] = useState<string | null>(null);

  const codeContent =
    activeCodeTab === 'api'
      ? RASPBERRY_API_SCRIPT
      : activeCodeTab === 'direct'
        ? RASPBERRY_DIRECT_DB_SCRIPT
        : PRISMA_SCHEMA_PREVIEW;

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(codeContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadPython = () => {
    const filename =
      activeCodeTab === 'direct' ? 'pluviometro_direct_db.py' : 'pluviometro.py';
    const content =
      activeCodeTab === 'direct' ? RASPBERRY_DIRECT_DB_SCRIPT : RASPBERRY_API_SCRIPT;
    const blob = new Blob([content], { type: 'text/x-python;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const parseResponseJson = async <T,>(res: Response): Promise<T | null> => {
    const raw = await res.text();
    if (!raw.trim().startsWith('{')) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    setConfigNotice(null);
    try {
      const res = await fetch('/api/station/config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name,
          location,
          mmPerPulse: Number(mmPerPulse.replace(',', '.')),
        }),
      });
      if (!res.ok) {
        const err = await parseResponseJson<{ erro?: string }>(res);
        setConfigNotice(err?.erro || 'Erro ao salvar calibração.');
      } else {
        setConfigNotice('Calibração salva no banco.');
        await onRefresh();
      }
    } catch {
      setConfigNotice('Falha de comunicação ao salvar.');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/station/ingest-key', {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${authToken}` },
      });
      const data = await parseResponseJson<{ apiKey?: string; erro?: string }>(res);
      if (!res.ok || !data?.apiKey) {
        setKeyError(data?.erro || 'Não foi possível gerar a chave.');
      } else {
        setGeneratedKey(data.apiKey);
        await onRefresh();
      }
    } catch {
      setKeyError('Erro de conexão ao gerar chave.');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleQueueOfflinePulse = () => {
    const nowUnix = Math.floor(Date.now() / 1000) - localQueue.length * 12;
    const item: OfflineQueuedItem = {
      eventUid: `raspi:${nowUnix}:${Math.random().toString(36).slice(2, 8)}`,
      mm: station.mmPerPulse,
      timestamp: nowUnix,
      queuedAt: nowUnix,
    };
    setLocalQueue((prev) => [...prev, item]);
    setQueueFeedback(null);
  };

  const handleFlushOfflineQueue = async () => {
    if (localQueue.length === 0) return;
    setFlushingQueue(true);
    setQueueFeedback(null);
    try {
      const res = await fetch('/api/demo/pulse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          count: localQueue.length,
          mode: 'queue_replay',
        }),
      });
      const data = await parseResponseJson<{ inserted?: number; deduplicated?: number; erro?: string }>(res);
      if (res.ok && data) {
        setQueueFeedback(
          `Lote sincronizado com sucesso: ${data.inserted ?? 0} pulso(s) inserido(s), ${data.deduplicated ?? 0} duplicado(s) ignorado(s).`,
        );
        setLocalQueue([]);
        await onRefresh();
      } else {
        setQueueFeedback(data?.erro || 'Erro ao sincronizar lote.');
      }
    } catch {
      setQueueFeedback('Falha na sincronização do lote.');
    } finally {
      setFlushingQueue(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top 2-column configuration and offline queue simulator */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* Station Calibration & API Key */}
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Calibração e Autenticação da Estação
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Ajuste o fator de conversão do pluviômetro basculante e gere a chave para o Raspberry Pi.
            </p>

            <form onSubmit={handleSaveConfig} className="mt-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Nome da Estação
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Calibração (mm por pulso)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.05"
                    max="5"
                    value={mmPerPulse}
                    onChange={(e) => setMmPerPulse(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 font-mono text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Localização / Ponto de Coleta
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
                  required
                />
              </div>

              <div className="flex items-center justify-between gap-4 pt-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {configNotice || `Fuso configurado: ${station.timezone}`}
                </span>
                <button
                  type="submit"
                  disabled={savingConfig}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-slate-900 dark:bg-sky-600 px-4 text-xs font-medium text-white hover:bg-slate-800 dark:hover:bg-sky-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Save className="h-3.5 w-3.5" />
                  {savingConfig ? 'Salvando...' : 'Salvar Calibração'}
                </button>
              </div>
            </form>
          </div>

          <div className="mt-6 border-t border-slate-200 dark:border-slate-800 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Chave de Ingestão (x-api-key)
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {station.keySource === 'env'
                    ? 'Configurada via variável de ambiente INGEST_API_KEY.'
                    : station.hasApiKeyConfigured
                      ? `Ativa no servidor (${station.apiKeyHint})`
                      : 'Nenhuma chave gerada ainda. Gere uma para autenticar o Raspberry Pi.'}
                </div>
              </div>
              {station.keySource !== 'env' && (
                <button
                  type="button"
                  onClick={handleGenerateKey}
                  disabled={generatingKey}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {station.hasApiKeyConfigured ? 'Rotacionar Chave' : 'Gerar Chave API'}
                </button>
              )}
            </div>

            {generatedKey && (
              <div className="mt-3 rounded-md border border-sky-200 dark:border-sky-800/80 bg-sky-50/70 dark:bg-sky-950/40 p-3">
                <div className="text-xs font-medium text-sky-900 dark:text-sky-200">
                  Copie esta chave agora — por segurança, apenas o hash fica armazenado no banco:
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-xs text-slate-900 dark:text-slate-100">
                  <code className="truncate">{generatedKey}</code>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(generatedKey)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 whitespace-nowrap shrink-0"
                  >
                    <Copy className="h-3 w-3" />
                    Copiar
                  </button>
                </div>
              </div>
            )}
            {keyError && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{keyError}</p>
            )}
          </div>
        </section>

        {/* Offline Queue Recovery Simulator */}
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Simulador de Fila Offline (Falha de Rede)
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Teste como o Raspberry Pi acumula pulsos localmente em SQLite durante quedas de internet e sincroniza em lote assíncrono quando a conexão volta.
                </p>
              </div>
              <WifiOff className="h-5 w-5 text-slate-400 shrink-0" />
            </div>

            <div className="mt-5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 dark:text-slate-400">
                  Pulsos retidos na fila local (simulação)
                </span>
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {localQueue.length} item(ns) · {formatMm(localQueue.length * station.mmPerPulse, 2)} mm
                </span>
              </div>

              {localQueue.length > 0 ? (
                <ul className="mt-3 max-h-36 overflow-y-auto divide-y divide-slate-200/70 dark:divide-slate-800 text-xs font-mono">
                  {localQueue.map((item) => (
                    <li
                      key={item.eventUid}
                      className="flex items-center justify-between py-1.5 text-slate-700 dark:text-slate-300"
                    >
                      <span className="truncate max-w-[230px]">{item.eventUid}</span>
                      <span>+{formatMm(item.mm, 2)} mm</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Fila local vazia. Clique em &ldquo;Enfileirar Pulso Offline&rdquo; para simular basculadas sem conexão.
                </p>
              )}
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {queueFeedback && (
              <div className="rounded-md border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
                {queueFeedback}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleQueueOfflinePulse}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                Enfileirar Pulso Offline
              </button>

              <button
                type="button"
                onClick={handleFlushOfflineQueue}
                disabled={localQueue.length === 0 || flushingQueue}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-sky-600 px-4 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                {flushingQueue ? 'Sincronizando lote...' : 'Restabelecer Rede & Enviar Lote'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Python & Prisma Code Viewer */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
          <div className="flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-900 p-1">
            {(
              [
                ['api', 'pluviometro.py (Node Tempo Real)'],
                ['direct', 'pluviometro_direct_db.py (Banco Direto)'],
                ['prisma', 'prisma/schema.prisma'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveCodeTab(tab)}
                className={`rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  activeCodeTab === tab
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {activeCodeTab !== 'prisma' && (
              <button
                type="button"
                onClick={handleDownloadPython}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" />
                Baixar .py
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyCode}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-slate-900 dark:bg-slate-800 px-3 text-xs font-medium text-white hover:bg-slate-800 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copiado' : 'Copiar Código'}
            </button>
          </div>
        </div>

        <pre className="max-h-[460px] overflow-auto bg-slate-950 p-5 font-mono text-xs leading-relaxed text-slate-200">
          <code>{codeContent}</code>
        </pre>
      </section>
    </div>
  );
}
