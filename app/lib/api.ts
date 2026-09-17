export async function request<T>(path: string, body?: unknown): Promise<T> {
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
      'The local server did not respond. Reopen EquityDesk and try again.',
    );
  }
  if (!r.ok) {
    const error =
      d && typeof d === 'object' && 'error' in d
        ? String(d.error)
        : 'Something went wrong. Please retry.';
    throw Error(error);
  }
  return d as T;
}
