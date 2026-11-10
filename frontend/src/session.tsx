import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Clinic, User } from './api';

export interface Session {
  user: User;
  clinics: Clinic[];
  /**
   * False until the clinic list has come back. Without this an empty
   * `clinics` means both "still fetching" and "this account is assigned to
   * no clinics", and a Secretary in the second case waits on a spinner that
   * never resolves.
   */
  clinicsLoaded: boolean;
  /** The active clinic (S02); undefined until one is chosen. */
  clinic?: Clinic;
  selectClinic: (id: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionContext');
  return s;
}

/** Current hash route, e.g. "#/appointments" → "/appointments". */
export function useRoute(): string {
  const read = () => window.location.hash.slice(1) || '/dashboard';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (path: string) => {
  window.location.hash = path;
};

/** Load data for a screen; `reload()` refetches. Errors become a message. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const run = useCallback(load, deps);
  const reload = useCallback(() => {
    setError(undefined);
    run()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [run]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}
