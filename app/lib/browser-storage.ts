import type { AppState, Quote } from './stocks';
import {
  accountState,
  changeAccount,
  makePreview,
  newBrowserAccount,
  type BrowserAccount,
} from './browser-account';

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('equitydesk-portfolio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('account');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        Error(
          'Browser storage is unavailable. Allow site storage to save your portfolio.',
        ),
      );
    request.onblocked = () =>
      reject(
        Error(
          'Close other EquityDesk tabs and reload to open your saved account.',
        ),
      );
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

// One IndexedDB transaction serializes changes across tabs and survives reloads.
async function update<T>(
  operation: (account: BrowserAccount) => T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('account', 'readwrite'),
      store = transaction.objectStore('account'),
      read = store.get('current');
    let result: T, failure: unknown;
    read.onsuccess = () => {
      try {
        const account: BrowserAccount = read.result ?? newBrowserAccount();
        if (account.version !== 1)
          throw Error(
            'This saved account needs a newer version of EquityDesk.',
          );
        result = operation(account);
        store.put(account, 'current');
      } catch (e) {
        failure = e;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () =>
      reject(
        failure ||
          Error(
            'Your browser could not save this change. Your previous account is kept.',
          ),
      );
  });
}

export async function browserRequest<T>(
  path: string,
  body: unknown,
  base: AppState,
): Promise<T> {
  if (path === '/api/state' && body === undefined)
    return update((account) => accountState(account, base) as T);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Error('Expected a valid form.');
  const form = body as Record<string, unknown>;
  if (path === '/api/paper/preview') {
    // Only the ticker goes to the server; shares, balances, and notes stay here.
    const symbol = String(form.symbol).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol))
      throw Error('Choose a valid company.');
    const response = await fetch(
      '/api/quotes?symbols=' + encodeURIComponent(symbol),
    );
    const result = (await response.json()) as {
      quotes?: Record<string, Quote>;
      error?: string;
    };
    const quote = result.quotes?.[symbol];
    if (!response.ok || !quote)
      throw Error(
        result.error || 'Yahoo could not supply a price for this trade.',
      );
    return update((account) => makePreview(account, form, quote) as T);
  }
  return update((account) => {
    changeAccount(account, path, form);
    return accountState(account, base) as T;
  });
}
