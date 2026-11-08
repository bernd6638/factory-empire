import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Me } from '../../lib/types';
import { LoadingBlock } from '../ui/core';
import { LiveProvider } from '../../lib/live';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });
}

/** Leitet nicht angemeldete Nutzer zur Login-Seite weiter und startet für angemeldete die Live-Verbindung. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useMe();
  const location = useLocation();
  if (isLoading) return <LoadingBlock className="min-h-screen" label="Sitzung wird geprüft …" />;
  if (!data || error) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <LiveProvider>{children}</LiveProvider>;
}
