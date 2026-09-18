import type { AppState } from './stocks';

let hostedState: AppState | undefined;
export async function request<T>(path: string, body?: unknown): Promise<T> {
  if (hostedState && (body !== undefined || path === '/api/state')) {
    const { browserRequest } = await import('./browser-storage');
    return browserRequest<T>(path, body, hostedState);
  }
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-EquityDesk': '1' },
          body: JSON.stringify(body),
        },
  );
  let d: unknown;
  try {
    d = await r.json();
  } catch {
    throw Error(
      'The app did not respond. Check your connection, reload, and try again.',
    );
  }
  if (!r.ok) {
    const error =
      d && typeof d === 'object' && 'error' in d
        ? String(d.error)
        : 'Something went wrong. Please retry.';
    throw Error(error);
  }
  if (path === '/api/state' && (d as AppState).storage === 'browser') {
    hostedState = d as AppState;
    const { browserRequest } = await import('./browser-storage');
    return browserRequest<T>(path, body, hostedState);
  }
  return d as T;
}
