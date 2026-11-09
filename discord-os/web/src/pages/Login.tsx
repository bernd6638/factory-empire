import { motion } from 'framer-motion';
import { Activity, Bot, Coins, ShieldCheck, Ticket, Workflow } from 'lucide-react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { useMe } from '../components/layout/AuthGate';
import { LogoMark } from '../components/layout/Logo';

const ERRORS: Record<string, string> = {
  denied: 'Die Anmeldung wurde abgebrochen.',
  state: 'Die Anmeldung ist abgelaufen. Bitte versuche es erneut.',
  oauth: 'Discord hat die Anmeldung abgelehnt. Prüfe Client-ID, Secret und Redirect-URL.',
};

const FEATURES = [
  { icon: ShieldCheck, title: 'Moderation & Auto-Mod', text: 'Spam-, Raid- und Link-Schutz in Echtzeit' },
  { icon: Activity, title: 'Live-Statistiken', text: 'Mitglieder, Nachrichten und Aktivität' },
  { icon: Ticket, title: 'Ticketsystem', text: 'Kategorien, Prioritäten und Transkripte' },
  { icon: Coins, title: 'Economy & Level', text: 'XP, Ranglisten, Shop und Firmen' },
  { icon: Workflow, title: 'Automatisierungen', text: 'Regeln, Zeitpläne und Erinnerungen' },
  { icon: Bot, title: 'Modular', text: 'Jedes Modul einzeln konfigurierbar' },
];

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const { data: me } = useMe();
  const error = params.get('error');
  const returnTo = params.get('returnTo') ?? '/servers';
  if (me) return <Navigate to={returnTo} replace />;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute top-1/4 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-brand-500/20 blur-[140px]" />
      <div className="pointer-events-none absolute right-[10%] bottom-0 h-[380px] w-[380px] rounded-full bg-accent-500/15 blur-[120px]" />
      <div className="relative grid w-full max-w-5xl items-center gap-10 lg:grid-cols-2">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5 }}>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-xs text-brand-300">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-brand-400" /> DISCORD OS · Control Center
          </div>
          <h1 className="text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
            Dein Discord-Server.
            <br />
            <span className="gradient-text">Vollständig unter Kontrolle.</span>
          </h1>
          <p className="mt-4 max-w-md text-fg-muted">Moderation, Statistiken, Tickets, Economy und Automatisierungen in einem Dashboard. Alles in Echtzeit mit deinem Bot verbunden.</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {FEATURES.map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.05 }} className="flex items-start gap-3 rounded-xl border border-line/70 bg-panel/50 p-3">
                <f.icon className="mt-0.5 h-4 w-4 text-brand-300" />
                <div>
                  <div className="text-sm font-medium">{f.title}</div>
                  <div className="text-xs text-fg-subtle">{f.text}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }} className="card mx-auto w-full max-w-md p-8 shadow-glow">
          <div className="mb-8 flex items-center gap-3">
            <LogoMark size={48} />
            <div>
              <div className="text-lg font-semibold">Anmelden</div>
              <div className="text-sm text-fg-muted">Mit deinem Discord-Konto</div>
            </div>
          </div>
          {error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{ERRORS[error] ?? 'Anmeldung fehlgeschlagen.'}</div>}
          <a
            href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
            className="flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-[#5865F2] font-medium text-white shadow-[0_10px_30px_-10px_#5865F2] transition hover:bg-[#4752c4] active:scale-[0.99]"
          >
            <DiscordIcon /> Mit Discord anmelden
          </a>
          <p className="mt-6 text-center text-xs leading-relaxed text-fg-subtle">
            Discord OS fragt nur deinen Benutzernamen und deine Serverliste ab (Scopes <code>identify</code> und <code>guilds</code>). Zugangsdaten werden verschlüsselt gespeichert.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
