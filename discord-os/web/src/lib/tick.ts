import { useEffect, useState } from 'react';

/**
 * Gemeinsamer Sekundentakt für Countdowns.
 * Nur die Komponenten, die die Zeit anzeigen, werden jede Sekunde neu gezeichnet –
 * nicht die ganze Seite. Ein einziger Timer für alle.
 */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: (now: number) => void) {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      if (document.hidden) return; // im Hintergrund-Tab nichts zeichnen
      const now = Date.now();
      for (const l of listeners) l(now);
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useTick(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}
