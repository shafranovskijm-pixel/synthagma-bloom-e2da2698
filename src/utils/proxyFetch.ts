/**
 * Proxy Fetch — глобальный перехватчик fetch + WebSocket.
 *
 * Назначение: обходить блокировку *.supabase.co у российских провайдеров
 * через ваш собственный reverse proxy (Nginx на Timeweb / VPS), который
 * стоит на том же домене, что и фронтенд. Это убирает зависимость от
 * Cloudflare Workers (которые тоже могут быть заблокированы).
 *
 * Схема (same-origin):
 *   {origin}/sb-api/...        → https://<supabase>/...        (auth/rest/realtime)
 *   {origin}/sb-functions/...  → https://<supabase>/functions/v1/...
 *   {origin}/sb-storage/...    → https://<supabase>/storage/v1/...
 *   {origin}/sb-realtime       → wss://<supabase>/realtime/v1/websocket (WS)
 *
 * Хост Supabase берётся из VITE_SUPABASE_URL.
 * Прокси-режим включается всегда на «прод-доменах» (sintagma.com.ru, Timeweb,
 * lovable.app), а на остальных — лениво при сетевой ошибке.
 *
 * Обратная совместимость: если на бэкенде ещё живут старые Cloudflare-субдомены
 * (api/functions/storage.sintagma.com.ru), их можно оставить как fallback —
 * см. LEGACY_HOSTS ниже.
 */

const SUPABASE_HOST = (() => {
  try {
    const url = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
    if (url) return new URL(url).host;
  } catch {
    // ignore
  }
  return 'atxwvjxbqjgkbjlhsdch.supabase.co';
})();

// Публичный Nginx-прокси на Timeweb. В Android WebView origin приложения —
// https://localhost, поэтому same-origin fallback указывал бы на сам телефон.
// Отдельный HTTPS-домен гарантирует, что native-сборка всегда идёт через VDS.
const PROXY_BASE_URL = 'https://api.xn--80aaiswd0ak.xn--p1ai';

// Префиксы — должны совпадать с Nginx-конфигом на VDS.
const SAME_ORIGIN_PREFIX = {
  api: '/sb-api',
  functions: '/sb-functions',
  storage: '/sb-storage',
  realtime: '/sb-realtime',
};

function getProxyHttpBase(): string {
  if (PROXY_BASE_URL) return PROXY_BASE_URL;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

function getProxyWsBase(): string {
  const http = getProxyHttpBase();
  return http.replace(/^http/, 'ws');
}

// Хосты, на которых прокси-режим включается ВСЕГДА (без ожидания ошибки).
// Сюда входят основной домен и любые публичные домены, где у пользователей
// гарантированно может не быть прямого доступа к Supabase.
// Принудительный прокси сейчас никому не нужен: основной домен
// sintagma.com.ru ходит в Supabase напрямую. Прокси-режим включается лениво
// только при фактической сетевой блокировке (см. installProxyFetch ниже).
const FORCE_PROXY_HOSTS_EXACT = new Set<string>([]);

// Любой кастомный домен на Timeweb (twc1.net) — тоже включаем прокси,
// потому что фронт там, а бэкенд за блокировкой.
function isForcedProxyHost(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  // Стандартный origin Capacitor Android. Обычная локальная Vite-разработка
  // работает на http://localhost и по-прежнему использует lazy fallback.
  if (h === 'localhost' && window.location.protocol === 'https:') return true;
  if (FORCE_PROXY_HOSTS_EXACT.has(h)) return true;
  return false;
}

const PROXY_FLAG_KEY = 'sintagma:use-proxy';
const PROXY_LAST_PROBE_KEY = 'sintagma:proxy-last-probe';
const PROXY_RESET_KEY = 'sintagma:proxy-reset-v2';
const PROBE_INTERVAL_MS = 30 * 60 * 1000;

// Одноразовый сброс залипшего legacy-прокси у пользователей,
// которые уже сохранили флаг на api.sintagma.com.ru.
try {
  if (typeof window !== 'undefined' && !localStorage.getItem(PROXY_RESET_KEY)) {
    localStorage.removeItem(PROXY_FLAG_KEY);
    localStorage.removeItem(PROXY_LAST_PROBE_KEY);
    localStorage.setItem(PROXY_RESET_KEY, '1');
  }
} catch {
  // ignore
}

function getProxyMode(): boolean {
  if (isForcedProxyHost()) return true;
  try {
    return localStorage.getItem(PROXY_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function setProxyMode(enabled: boolean) {
  if (isForcedProxyHost() && !enabled) return;
  try {
    if (enabled) localStorage.setItem(PROXY_FLAG_KEY, '1');
    else localStorage.removeItem(PROXY_FLAG_KEY);
  } catch {
    // ignore
  }
}

/** Прямой Supabase-URL → URL прокси-сервера (или same-origin). */
function rewriteUrl(url: string): string {
  if (!url.includes(SUPABASE_HOST)) return url;
  try {
    const u = new URL(url);
    let prefix: string;
    if (u.pathname.startsWith('/functions/v1/')) {
      prefix = SAME_ORIGIN_PREFIX.functions;
      u.pathname = u.pathname.replace(/^\/functions\/v1/, '');
    } else if (u.pathname.startsWith('/storage/v1/')) {
      prefix = SAME_ORIGIN_PREFIX.storage;
      u.pathname = u.pathname.replace(/^\/storage\/v1/, '');
    } else {
      prefix = SAME_ORIGIN_PREFIX.api;
    }
    const base = getProxyHttpBase();
    const path = (prefix + u.pathname).replace(/\/{2,}/g, '/');
    return base + path + (u.search || '');
  } catch {
    return url;
  }
}

/** wss:// URL Supabase realtime → wss://<proxy>/sb-realtime?... */
function rewriteWsUrl(url: string): string {
  if (!url.includes(SUPABASE_HOST)) return url;
  try {
    const u = new URL(url);
    return getProxyWsBase() + SAME_ORIGIN_PREFIX.realtime + (u.search || '');
  } catch {
    return url;
  }
}

function isNetworkBlock(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === 'TypeError' ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('load failed') ||
    msg.includes('err_blocked') ||
    msg.includes('err_connection') ||
    msg.includes('err_name_not_resolved')
  );
}

let originalFetch: typeof fetch | null = null;
let originalWebSocket: typeof WebSocket | null = null;

export function installProxyFetch() {
  if (typeof window === 'undefined') return;

  // ============= Fetch перехватчик =============
  if (!originalFetch) {
    originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const urlStr = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;

      // Перехватываем только Supabase-домен. Остальное идёт напрямую.
      if (!urlStr.includes(SUPABASE_HOST)) {
        return originalFetch!(input, init);
      }

      const useProxy = getProxyMode();

      if (useProxy) {
        const proxyUrl = rewriteUrl(urlStr);
        if (typeof input === 'string' || input instanceof URL) {
          return originalFetch!(proxyUrl, init);
        }
        const req = input as Request;
        return originalFetch!(proxyUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.clone().blob(),
          mode: req.mode,
          credentials: req.credentials,
          cache: req.cache,
          redirect: req.redirect,
          referrer: req.referrer,
          integrity: req.integrity,
          ...init,
        });
      }

      // Lazy-режим: прямой запрос, при сетевой ошибке — переключаемся на прокси.
      try {
        return await originalFetch!(input, init);
      } catch (err) {
        if (isNetworkBlock(err)) {
          const proxyUrl = rewriteUrl(urlStr);
          try {
            const resp = await originalFetch!(proxyUrl, init);
            setProxyMode(true);
            console.warn('[ProxyFetch] Direct Supabase blocked, switched to same-origin proxy:', proxyUrl);
            window.dispatchEvent(new CustomEvent('sintagma:proxy-activated'));
            return resp;
          } catch {
            throw err;
          }
        }
        throw err;
      }
    };

    if (!isForcedProxyHost() && getProxyMode()) {
      setTimeout(probeDirectChannel, 60_000);
    }
  }

  // ============= WebSocket перехватчик (Realtime) =============
  if (!originalWebSocket && typeof WebSocket !== 'undefined') {
    originalWebSocket = window.WebSocket;
    const Original = originalWebSocket;

    class PatchedWebSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        const urlStr = url instanceof URL ? url.toString() : url;
        let finalUrl = urlStr;

        if (urlStr.includes(SUPABASE_HOST) && getProxyMode()) {
          finalUrl = rewriteWsUrl(urlStr);
          if (finalUrl !== urlStr) {
            console.info('[ProxyFetch] WebSocket → proxy:', finalUrl);
          }
        }

        super(finalUrl, protocols);
      }
    }

    Object.defineProperty(PatchedWebSocket, 'CONNECTING', { value: Original.CONNECTING });
    Object.defineProperty(PatchedWebSocket, 'OPEN', { value: Original.OPEN });
    Object.defineProperty(PatchedWebSocket, 'CLOSING', { value: Original.CLOSING });
    Object.defineProperty(PatchedWebSocket, 'CLOSED', { value: Original.CLOSED });

    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
  }

  if (isForcedProxyHost()) {
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('sintagma:proxy-activated'));
    }, 0);
  }
}

async function probeDirectChannel() {
  if (!originalFetch) return;
  if (isForcedProxyHost()) return;
  try {
    const last = Number(localStorage.getItem(PROXY_LAST_PROBE_KEY) || 0);
    if (Date.now() - last < PROBE_INTERVAL_MS) return;
    localStorage.setItem(PROXY_LAST_PROBE_KEY, String(Date.now()));

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await originalFetch(`https://${SUPABASE_HOST}/auth/v1/health`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    if (resp.ok || resp.status === 401) {
      setProxyMode(false);
      console.info('[ProxyFetch] Direct channel restored, proxy disabled');
    }
  } catch {
    // всё ещё заблокировано
  }
}

export function getProxyStatus() {
  return {
    enabled: getProxyMode(),
    forced: isForcedProxyHost(),
    sameOriginPrefix: SAME_ORIGIN_PREFIX,
    supabaseHost: SUPABASE_HOST,
  };
}

export function forceProxyMode(enabled: boolean) {
  setProxyMode(enabled);
}
