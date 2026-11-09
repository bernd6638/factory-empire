import { useSyncExternalStore } from 'react';

/** Leistungsmodus „Effekte reduzieren“ – im Browser gespeichert, sofort wirksam. */
const KEY = 'dos:reduce-effects';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let value = read();
export function applyPerfClass() {
  document.documentElement.classList.toggle('reduce-effects', value);
}

export function setReduceEffects(on: boolean) {
  value = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignorieren */
  }
  applyPerfClass();
  listeners.forEach((l) => l());
}

export function useReduceEffects(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => value,
  );
}
