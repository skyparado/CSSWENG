// Thin fetch wrapper for the backend API. Types come from the shared schemas
// package so the client and server agree on shapes.

export interface Clinic {
  id: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  timezone: string;
  isActive: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<{ status: string }>('/health'),
  listClinics: () =>
    get<{ items: Clinic[]; total: number }>('/api/clinics?page=1&pageSize=100'),
};
