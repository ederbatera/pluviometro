import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Droplets,
  LogIn,
  LogOut,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
} from 'lucide-react';
import { AuthGateCard } from './components/AuthGateCard.tsx';
import { PulseLogTable } from './components/PulseLogTable.tsx';
import { type ChartMode, RainChart } from './components/RainChart.tsx';
import { RaspberryIntegrationPanel } from './components/RaspberryIntegrationPanel.tsx';
import type {
  AuthStatusResponse,
  AuthUserDto,
  TelemetryResponse,
} from './types/telemetry.ts';
import {
  formatDateTimePt,
  formatInteger,
  formatMm,
  formatRelativeTimePt,
  getIntensityMeta,
} from './utils/formatters.ts';

type ActiveTab = 'overview' | 'charts' | 'logs' | 'raspberry' | 'login';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [chartMode, setChartMode] = useState<ChartMode>('24h');
  const [showCumulative, setShowCumulative] = useState(true);
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(false);

  // In-memory Bearer session token (never stored in localStorage/sessionStorage)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const authTokenRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const [authStatus, setAuthStatus] = useState<AuthStatusResponse>({
    authenticated: false,
    setupRequired: false,
    authMode: 'database',
    mariadbConnected: false,
    mariadbConfigured: false,
    user: null,
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const fetchAuthStatus = useCallback(async (tokenOverride?: string | null) => {
    const tokenToUse = tokenOverride !== undefined ? tokenOverride : authToken;
    try {
      const headers: HeadersInit = tokenToUse
        ? { Authorization: `Bearer ${tokenToUse}` }
        : {};
      const res = await fetch('/api/auth/status', {
        headers: { ...headers, Accept: 'application/json' },
        cache: 'no-store',
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data: AuthStatusResponse = await res.json();
        setAuthStatus(data);
        if (!data.authenticated && tokenToUse) {
          setAuthToken(null);
        }
      } else {
        console.error('[Pluviômetro] Falha ao consultar status de sessão:', res.status);
      }
    } catch (err) {
      console.error('[Pluviômetro] Erro ao consultar status de sessão:', err);
    }
  }, [authToken]);

  const fetchTelemetry = useCallback(async (tokenOverride?: string | null) => {
    const tokenToUse = tokenOverride !== undefined ? tokenOverride : authToken;
    try {
      const headers: HeadersInit = tokenToUse
        ? { Authorization: `Bearer ${tokenToUse}` }
        : {};
      const res = await fetch('/api/telemetry', {
        headers: { ...headers, Accept: 'application/json' },
        cache: 'no-store',
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        console.error(`[Pluviômetro] Falha ao carregar telemetria: HTTP ${res.status}`);
        return;
      }
      const data: TelemetryResponse = await res.json();
      setTelemetry(data);
    } catch (err) {
      console.error('[Pluviômetro] Erro ao conectar à API de telemetria:', err);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  // Carga inicial única + assinatura em tempo real via WebSocket (sem polling periódico no banco)
  useEffect(() => {
    void fetchAuthStatus();
    void fetchTelemetry();

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    const backoffMs = [1000, 2000, 5000, 10000, 30000];

    const connectWebSocket = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;

      try {
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          reconnectAttempt = 0;
          socket.send(JSON.stringify({ type: 'auth', token: authTokenRef.current }));
        };

        socket.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data as string) as {
              type?: string;
              data?: TelemetryResponse;
            };
            if (payload.type === 'telemetry:update' && payload.data) {
              setTelemetry(payload.data);
              setLoading(false);
            }
          } catch (err) {
            console.error('[Pluviômetro] Erro ao interpretar atualização em tempo real:', err);
          }
        };

        socket.onerror = () => {
          console.warn('[Pluviômetro] Conexão em tempo real interrompida; tentando reconectar.');
        };

        socket.onclose = () => {
          if (wsRef.current === socket) {
            wsRef.current = null;
          }
          if (disposed) return;
          const wait = backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)];
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(connectWebSocket, wait);
        };
      } catch (err) {
        console.warn('[Pluviômetro] Falha ao iniciar WebSocket:', err);
      }
    };

    connectWebSocket();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atualiza permissões do canal WebSocket ao fazer login/logout
  useEffect(() => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'auth', token: authToken }));
    }
  }, [authToken]);

  const handleAuthenticated = async (token: string, user: AuthUserDto) => {
    setAuthToken(token);
    setAuthStatus({
      authenticated: true,
      setupRequired: false,
      authMode: authStatus.authMode,
      mariadbConnected: true,
      mariadbConfigured: authStatus.mariadbConfigured,
      user,
    });
    if (activeTab === 'login') {
      setActiveTab('overview');
    }
    await fetchTelemetry(token);
  };

  const handleLogout = async () => {
    if (authToken) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      }).catch((err) => {
        console.error('[Pluviômetro] Erro ao encerrar sessão:', err);
      });
    }
    setAuthToken(null);
    await fetchAuthStatus(null);
    await fetchTelemetry(null);
    if (activeTab === 'logs' || activeTab === 'raspberry' || activeTab === 'login') {
      setActiveTab('overview');
    }
  };

  const handleSimulatePulse = async (count = 1) => {
    if (!authToken) {
      setActiveTab('login');
      return;
    }
    setBusyAction('pulse');
    try {
      const res = await fetch('/api/demo/pulse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ count, mode: 'live' }),
      });
      if (!res.ok) {
        console.error('[Pluviômetro] Erro ao registrar pulso simulado:', res.status);
      }
      await fetchTelemetry();
    } catch (err) {
      console.error('[Pluviômetro] Falha ao registrar pulso simulado:', err);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSeedHistory = async () => {
    if (!authToken) {
      setActiveTab('login');
      return;
    }
    setBusyAction('seed');
    try {
      const res = await fetch('/api/demo/seed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        console.error('[Pluviômetro] Erro ao popular histórico:', res.status);
      }
      await fetchTelemetry();
    } catch (err) {
      console.error('[Pluviômetro] Falha ao popular histórico:', err);
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetData = async () => {
    if (!authToken) return;
    setBusyAction('reset');
    try {
      const res = await fetch('/api/demo/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        console.error('[Pluviômetro] Erro ao limpar registros:', res.status);
      }
      await fetchTelemetry();
    } catch (err) {
      console.error('[Pluviômetro] Falha ao limpar registros:', err);
    } finally {
      setBusyAction(null);
    }
  };

  const isAuthenticated = Boolean(authToken && authStatus.authenticated);

  const navItems: readonly [ActiveTab, string][] = isAuthenticated
    ? [
        ['overview', 'Visão Geral'],
        ['charts', 'Gráficos'],
        ['logs', 'Registros'],
        ['raspberry', 'Raspberry Pi'],
      ]
    : [
        ['overview', 'Visão Geral'],
        ['charts', 'Gráficos'],
      ];

  const intensityMeta = telemetry
    ? getIntensityMeta(telemetry.intensity.level)
    : getIntensityMeta('dry');

  const gaugePercent = telemetry
    ? Math.min(100, Math.max(0, (telemetry.intensity.mmPerHour / 50) * 100))
    : 0;

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 transition-colors">
      {/* Top Bar Contract: 3 single-line zones separated by gap-8 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#111827]/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 h-16">
          {/* Zone 1: Brand Logo & Title */}
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('overview');
            }}
            className="inline-flex items-center gap-2.5 font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
          >
            <img
              src="/assets/aistudio/ema-logo_779c7a6d.svg"
              alt="Logo EMA"
              className="h-7 w-auto shrink-0"
            />
            <span>Pluviômetro | EMA</span>
          </a>

          {/* Zone 2: Navigation links (Registros & Raspberry Pi visible only when logged in) */}
          <nav className="flex items-center gap-5 sm:gap-7 overflow-x-auto">
            {navItems.map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`relative inline-flex items-center gap-1.5 py-5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === tab
                    ? 'text-sky-600 dark:text-sky-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <span>{label}</span>
                {activeTab === tab && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-sky-600 dark:bg-sky-400" />
                )}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 Primary CTA */}
          <div className="flex items-center shrink-0">
            {isAuthenticated ? (
              <button
                type="button"
                onClick={() => void handleSimulatePulse(1)}
                disabled={busyAction !== null}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-sky-600 px-4 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                <Droplets className="h-3.5 w-3.5" />
                {busyAction === 'pulse' ? 'Registrando...' : 'Registrar Pulso'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('login')}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-slate-900 dark:bg-sky-600 px-4 text-xs font-medium text-white hover:bg-slate-800 dark:hover:bg-sky-500 transition-colors whitespace-nowrap shrink-0"
              >
                <LogIn className="h-3.5 w-3.5" />
                Entrar
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
        {/* Workspace Toolbar: unboxed metadata + workspace actions */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 dark:border-slate-800 pb-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-medium text-slate-900 dark:text-slate-200">
              {telemetry?.station.name ?? 'Estação Principal'}
            </span>
            <span aria-hidden="true">·</span>
            <span>{telemetry?.station.location ?? 'Ponto Meteorológico 01'}</span>
            {isAuthenticated && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">
                  {formatMm(telemetry?.station.mmPerPulse ?? 0.25, 2)} mm/pulso
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {isAuthenticated ? 'Último pulso:' : 'Último registro:'}{' '}
              <strong className="font-mono font-medium text-slate-800 dark:text-slate-200">
                {telemetry?.station.lastPulseAt
                  ? `${formatDateTimePt(telemetry.station.lastPulseAt)} (${formatRelativeTimePt(telemetry.station.lastPulseAt)})`
                  : 'sem registros recentes'}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void fetchTelemetry()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Atualizar
            </button>

            <button
              type="button"
              onClick={() => setDarkMode((prev) => !prev)}
              aria-label={darkMode ? 'Ativar tema claro' : 'Ativar tema escuro'}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {darkMode ? 'Claro' : 'Escuro'}
            </button>

            {isAuthenticated && telemetry && telemetry.station.totalPulsesAllTime > 0 && (
              <button
                type="button"
                onClick={() => void handleResetData()}
                disabled={busyAction !== null}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-200 dark:hover:border-rose-900 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Limpar Banco
              </button>
            )}

            {isAuthenticated && authStatus.user && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sair ({authStatus.user.username})
              </button>
            )}
          </div>
        </div>

        {/* Loading skeleton */}
        {loading && !telemetry && activeTab !== 'login' && (
          <div className="space-y-6 animate-pulse">
            <div className="h-44 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="h-28 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]"
                />
              ))}
            </div>
            <div className="h-80 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]" />
          </div>
        )}

        {/* Login View */}
        {activeTab === 'login' && !isAuthenticated && (
          <AuthGateCard
            authStatus={authStatus}
            sectionTitle="Acesso Restrito"
            sectionDescription="Entre com suas credenciais para acessar os controles e registros administrativos da estação."
            onAuthenticated={handleAuthenticated}
            onCancel={() => setActiveTab('overview')}
          />
        )}

        {telemetry && activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Focal Anchor: Velocidade / Intensidade Atual da Chuva */}
            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
                <div className="lg:col-span-7 space-y-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Velocidade Atual da Chuva (Média 15 min)
                    </span>
                    <span className={`text-sm font-semibold ${intensityMeta.textClass}`}>
                      <span aria-hidden="true" className="mr-1.5">
                        {intensityMeta.glyph}
                      </span>
                      {telemetry.intensity.label}
                    </span>
                  </div>

                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-5xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                      {formatMm(telemetry.intensity.mmPerHour)}
                    </span>
                    <span className="font-mono text-lg text-slate-500 dark:text-slate-400">
                      mm/h
                    </span>
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      Taxa instantânea (5 min):{' '}
                      <strong className="font-mono text-slate-800 dark:text-slate-200">
                        {formatMm(telemetry.intensity.mmPerHourInstant)} mm/h
                      </strong>
                    </span>
                  </div>

                  {/* Meteorological Scale Bar */}
                  <div className="space-y-1.5">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div
                        className={`h-full transition-all duration-300 ${intensityMeta.barClass}`}
                        style={{
                          width: `${Math.max(gaugePercent, telemetry.intensity.mmPerHour > 0 ? 4 : 0)}%`,
                        }}
                      />
                    </div>
                    <div className="flex justify-between font-mono text-[11px] text-slate-400 dark:text-slate-500">
                      <span>0 mm/h</span>
                      <span>Fraca &lt; 2,5</span>
                      <span>Moderada &lt; 10</span>
                      <span>Forte &lt; 50</span>
                      <span>Torrencial 50+</span>
                    </div>
                  </div>
                </div>

                {/* Right split: Meteorological summary (public) or technical diagnostics (authenticated only) */}
                <div className="lg:col-span-5 lg:border-l lg:border-slate-200 dark:lg:border-slate-800 lg:pl-6 space-y-4">
                  {isAuthenticated ? (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Pulsos (15 min)
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatInteger(telemetry.intensity.pulsesLast15m)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Pulsos (60 min)
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatInteger(telemetry.intensity.pulsesLast60m)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Total Histórico
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatMm(telemetry.station.totalMmAllTime)}{' '}
                          <span className="text-xs font-normal text-slate-400">mm</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Fila / Sync
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatInteger(telemetry.queueStats.pendingInSqlite)}
                          <span className="text-xs font-normal text-slate-400 ml-1">
                            / {formatInteger(telemetry.queueStats.processedTotal)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Chuva Hoje
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatMm(telemetry.accumulated.todayMm)}{' '}
                          <span className="text-xs font-normal text-slate-400">mm</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Pico Diário (Mês)
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatMm(telemetry.accumulated.peakDailyMmMonth)}{' '}
                          <span className="text-xs font-normal text-slate-400">mm</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Dias com Chuva (Mês)
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatInteger(telemetry.accumulated.rainyDaysInMonth)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Total Histórico
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                          {formatMm(telemetry.station.totalMmAllTime)}{' '}
                          <span className="text-xs font-normal text-slate-400">mm</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {isAuthenticated && (
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={() => void handleSimulatePulse(8)}
                        disabled={busyAction !== null}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                      >
                        Simular Chuva (+8 pulsos)
                      </button>
                      {telemetry.station.totalPulsesAllTime === 0 && (
                        <button
                          type="button"
                          onClick={() => void handleSeedHistory()}
                          disabled={busyAction !== null}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                        >
                          Popular 30 Dias
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* 4-Column Accumulated KPI Strip (Dia, 24h, Semana, Mês) */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800">
              <div className="p-5">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Chuva Hoje (Dia)
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-900 dark:text-slate-100">
                    {formatMm(telemetry.accumulated.todayMm)}
                  </span>
                  <span className="font-mono text-sm text-slate-500 dark:text-slate-400">mm</span>
                </div>
                <div className="mt-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {isAuthenticated
                    ? `${formatInteger(telemetry.accumulated.todayPulses)} basculadas hoje`
                    : 'Acumulado desde 00:00'}
                </div>
              </div>

              <div className="p-5">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Últimas 24 Horas
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-900 dark:text-slate-100">
                    {formatMm(telemetry.accumulated.last24hMm)}
                  </span>
                  <span className="font-mono text-sm text-slate-500 dark:text-slate-400">mm</span>
                </div>
                <div className="mt-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {isAuthenticated
                    ? `${formatInteger(telemetry.accumulated.last24hPulses)} pulsos em 24h`
                    : 'Janela móvel contínua'}
                </div>
              </div>

              <div className="p-5">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Semana Atual
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-900 dark:text-slate-100">
                    {formatMm(telemetry.accumulated.weekMm)}
                  </span>
                  <span className="font-mono text-sm text-slate-500 dark:text-slate-400">mm</span>
                </div>
                <div className="mt-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {isAuthenticated
                    ? `${telemetry.accumulated.rainyDaysInWeek} dia(s) com chuva · ${formatInteger(telemetry.accumulated.weekPulses)}p`
                    : `${telemetry.accumulated.rainyDaysInWeek} dia(s) com chuva`}
                </div>
              </div>

              <div className="p-5">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Mês Atual
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-900 dark:text-slate-100">
                    {formatMm(telemetry.accumulated.monthMm)}
                  </span>
                  <span className="font-mono text-sm text-slate-500 dark:text-slate-400">mm</span>
                </div>
                <div className="mt-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {telemetry.accumulated.rainyDaysInMonth} dia(s) · pico {formatMm(telemetry.accumulated.peakDailyMmMonth)} mm
                </div>
              </div>
            </section>

            {/* Primary Interactive Chart Panel */}
            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    {chartMode === '24h' && 'Precipitação por Hora (Últimas 24h)'}
                    {chartMode === 'weekly' && 'Acumulado Diário (Últimos 7 Dias)'}
                    {chartMode === 'monthly' && 'Acumulado Diário (Mês Atual / 30 Dias)'}
                    {chartMode === 'velocity' && 'Velocidade da Chuva (Últimas 2 Horas)'}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Distribuição temporal da precipitação registrada pela estação.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {chartMode !== 'velocity' && (
                    <button
                      type="button"
                      onClick={() => setShowCumulative((v) => !v)}
                      className={`h-8 rounded-md border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        showCumulative
                          ? 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Linha Acumulada
                    </button>
                  )}

                  <div className="flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-900 p-1">
                    {(
                      [
                        ['24h', '24 Horas'],
                        ['weekly', 'Semanal'],
                        ['monthly', 'Mensal'],
                        ['velocity', 'Velocidade'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setChartMode(key)}
                        className={`rounded px-3 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                          chartMode === key
                            ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <RainChart
                mode={chartMode}
                hourly24h={telemetry.series.hourly24h}
                weekly7d={telemetry.series.weekly7d}
                monthly30d={telemetry.series.monthly30d}
                velocity2h={telemetry.series.velocity2h}
                showCumulative={showCumulative}
                showPulses={isAuthenticated}
              />
            </section>
          </div>
        )}

        {/* Comparative Multi-Chart Tab */}
        {telemetry && activeTab === 'charts' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Velocidade da Chuva (Últimas 2h)
                </h2>
                <span className="font-mono text-xs text-sky-600 dark:text-sky-400">
                  Atual: {formatMm(telemetry.intensity.mmPerHour)} mm/h
                </span>
              </div>
              <RainChart
                mode="velocity"
                hourly24h={telemetry.series.hourly24h}
                weekly7d={telemetry.series.weekly7d}
                monthly30d={telemetry.series.monthly30d}
                velocity2h={telemetry.series.velocity2h}
                showPulses={isAuthenticated}
                height={240}
              />
            </section>

            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Precipitação Horária (Últimas 24h)
                </h2>
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  Total: {formatMm(telemetry.accumulated.last24hMm)} mm
                </span>
              </div>
              <RainChart
                mode="24h"
                hourly24h={telemetry.series.hourly24h}
                weekly7d={telemetry.series.weekly7d}
                monthly30d={telemetry.series.monthly30d}
                velocity2h={telemetry.series.velocity2h}
                showCumulative
                showPulses={isAuthenticated}
                height={240}
              />
            </section>

            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Acumulado Semanal (7 Dias)
                </h2>
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  Semana atual: {formatMm(telemetry.accumulated.weekMm)} mm
                </span>
              </div>
              <RainChart
                mode="weekly"
                hourly24h={telemetry.series.hourly24h}
                weekly7d={telemetry.series.weekly7d}
                monthly30d={telemetry.series.monthly30d}
                velocity2h={telemetry.series.velocity2h}
                showCumulative
                showPulses={isAuthenticated}
                height={240}
              />
            </section>

            <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5">
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Evolução Mensal ({telemetry.accumulated.rainyDaysInMonth} dia(s) com chuva)
                </h2>
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  Mês atual: {formatMm(telemetry.accumulated.monthMm)} mm
                </span>
              </div>
              <RainChart
                mode="monthly"
                hourly24h={telemetry.series.hourly24h}
                weekly7d={telemetry.series.weekly7d}
                monthly30d={telemetry.series.monthly30d}
                velocity2h={telemetry.series.velocity2h}
                showCumulative
                showPulses={isAuthenticated}
                height={240}
              />
            </section>
          </div>
        )}

        {/* Restricted Tab: Registros (Rendered only when authenticated) */}
        {activeTab === 'logs' && isAuthenticated && authToken && telemetry && (
          <PulseLogTable pulses={telemetry.recentPulses} authToken={authToken} />
        )}

        {/* Restricted Tab: Raspberry Pi (Rendered only when authenticated) */}
        {activeTab === 'raspberry' && isAuthenticated && authToken && telemetry && (
          <RaspberryIntegrationPanel
            station={telemetry.station}
            authToken={authToken}
            onRefresh={() => fetchTelemetry()}
          />
        )}
      </main>
    </div>
  );
}
