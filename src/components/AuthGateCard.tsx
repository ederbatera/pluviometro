import { useState } from 'react';
import { KeyRound, Lock, ShieldCheck, UserPlus } from 'lucide-react';
import type { AuthStatusResponse, AuthUserDto } from '../types/telemetry.ts';

interface AuthGateCardProps {
  authStatus: AuthStatusResponse;
  sectionTitle: string;
  sectionDescription: string;
  onAuthenticated: (token: string, user: AuthUserDto) => Promise<void>;
  onCancel?: () => void;
}

export function AuthGateCard({
  authStatus,
  sectionTitle,
  sectionDescription,
  onAuthenticated,
  onCancel,
}: AuthGateCardProps) {
  const isSetup = authStatus.setupRequired && authStatus.authMode === 'database';

  const [username, setUsername] = useState(isSetup ? 'admin' : '');
  const [displayName, setDisplayName] = useState('Administrador');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const endpoint = isSetup ? '/api/auth/setup' : '/api/auth/login';
      const body = isSetup
        ? { username, displayName, password }
        : { username, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      const rawText = await res.text();
      let data: { erro?: string; token?: string; user?: AuthUserDto } | null = null;
      if (rawText.trim().startsWith('{')) {
        try {
          data = JSON.parse(rawText) as { erro?: string; token?: string; user?: AuthUserDto };
        } catch {
          data = null;
        }
      }

      if (!res.ok || !data?.token || !data.user) {
        if (res.status >= 500 || !data) {
          console.error('[AuthGateCard] Resposta inesperada ao autenticar:', res.status, data?.erro ?? rawText.slice(0, 120));
          setError('Não foi possível validar o acesso no momento. Tente novamente em instantes.');
        } else {
          setError(data.erro || 'Usuário ou senha inválidos.');
        }
        return;
      }

      await onAuthenticated(data.token, data.user);
      setPassword('');
    } catch (err) {
      console.error('[AuthGateCard] Falha de comunicação ao autenticar:', err);
      setError('Não foi possível validar o acesso no momento. Tente novamente em instantes.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto max-w-md rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sky-600 dark:text-sky-400 shrink-0">
          {isSetup ? <UserPlus className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isSetup ? 'Configurar Acesso Inicial' : sectionTitle}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {isSetup
              ? 'Crie o usuário administrador inicial para gerenciar a estação meteorológica.'
              : sectionDescription}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        {isSetup && (
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Nome de Exibição
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              minLength={2}
              autoComplete="name"
              className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Usuário
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            placeholder="admin"
            autoComplete="username"
            className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Senha
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isSetup ? 6 : 1}
            placeholder={isSetup ? 'Mínimo 6 caracteres' : 'Digite sua senha'}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            className="h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 dark:bg-sky-600 px-4 text-xs font-medium text-white hover:bg-slate-800 dark:hover:bg-sky-500 disabled:opacity-60 transition-colors"
          >
            {isSetup ? (
              <>
                <ShieldCheck className="h-3.5 w-3.5" />
                {submitting ? 'Criando acesso...' : 'Criar Administrador e Entrar'}
              </>
            ) : (
              <>
                <KeyRound className="h-3.5 w-3.5" />
                {submitting ? 'Autenticando...' : 'Entrar'}
              </>
            )}
          </button>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-9 w-full items-center justify-center rounded-md border border-slate-200 dark:border-slate-700 px-4 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              Voltar ao Painel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
