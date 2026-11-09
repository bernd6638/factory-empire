import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';
import { applyPerfClass, useReduceEffects } from './lib/perf';
import { App } from './App';
import { ToastProvider, ConfirmProvider } from './components/ui/overlay';
import { ApiError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && [401, 403, 404].includes(err.status)) && count < 2,
    },
  },
});

applyPerfClass();

/** Animationen abschalten, wenn „Effekte reduzieren“ aktiv ist oder das System es wünscht. */
function Motion({ children }: { children: ReactNode }) {
  const reduce = useReduceEffects();
  return <MotionConfig reducedMotion={reduce ? 'always' : 'user'}>{children}</MotionConfig>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Motion>
        <BrowserRouter>
          <ToastProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </ToastProvider>
        </BrowserRouter>
      </Motion>
    </QueryClientProvider>
  </StrictMode>,
);
