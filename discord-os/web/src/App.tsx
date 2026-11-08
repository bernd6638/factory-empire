import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/layout/AuthGate';
import { GuildLayout } from './components/layout/AppLayout';
import { LoadingBlock } from './components/ui/core';
import { LoginPage } from './pages/Login';
import { ServersPage } from './pages/Servers';

const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ServerPage = lazy(() => import('./pages/Server'));
const MembersPage = lazy(() => import('./pages/Members'));
const ModerationPage = lazy(() => import('./pages/Moderation'));
const LevelingPage = lazy(() => import('./pages/Leveling'));
const TicketsPage = lazy(() => import('./pages/Tickets'));
const EconomyPage = lazy(() => import('./pages/Economy'));
const AutomationsPage = lazy(() => import('./pages/Automations'));
const VoicePage = lazy(() => import('./pages/Voice'));
const LogsPage = lazy(() => import('./pages/Logs'));
const PluginsPage = lazy(() => import('./pages/Plugins'));
const SettingsPage = lazy(() => import('./pages/Settings'));

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="gradient-text text-6xl font-bold">404</div>
      <p className="mt-3 text-fg-muted">Diese Seite existiert nicht.</p>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<LoadingBlock className="min-h-screen" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/servers"
          element={
            <AuthGate>
              <ServersPage />
            </AuthGate>
          }
        />
        <Route
          path="/guild/:guildId"
          element={
            <AuthGate>
              <GuildLayout />
            </AuthGate>
          }
        >
          <Route index element={<Suspense fallback={<LoadingBlock />}><DashboardPage /></Suspense>} />
          <Route path="server" element={<Suspense fallback={<LoadingBlock />}><ServerPage /></Suspense>} />
          <Route path="members" element={<Suspense fallback={<LoadingBlock />}><MembersPage /></Suspense>} />
          <Route path="moderation" element={<Suspense fallback={<LoadingBlock />}><ModerationPage /></Suspense>} />
          <Route path="leveling" element={<Suspense fallback={<LoadingBlock />}><LevelingPage /></Suspense>} />
          <Route path="tickets" element={<Suspense fallback={<LoadingBlock />}><TicketsPage /></Suspense>} />
          <Route path="economy" element={<Suspense fallback={<LoadingBlock />}><EconomyPage /></Suspense>} />
          <Route path="automations" element={<Suspense fallback={<LoadingBlock />}><AutomationsPage /></Suspense>} />
          <Route path="voice" element={<Suspense fallback={<LoadingBlock />}><VoicePage /></Suspense>} />
          <Route path="logs" element={<Suspense fallback={<LoadingBlock />}><LogsPage /></Suspense>} />
          <Route path="plugins" element={<Suspense fallback={<LoadingBlock />}><PluginsPage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<LoadingBlock />}><SettingsPage /></Suspense>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="/" element={<Navigate to="/servers" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
