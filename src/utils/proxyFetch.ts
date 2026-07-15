/**
 * Proxy Fetch — глобальный перехватчик fetch, WebSocket и URL ресурсов.
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
export function rewriteSupabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.host !== SUPABASE_HOST) return url;
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

const RESOURCE_URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'poster',
  'data',
  'data-src',
]);
const RESOURCE_SRCSET_ATTRIBUTES = new Set(['srcset', 'data-srcset']);
const RESOURCE_ATTRIBUTES = [
  ...RESOURCE_URL_ATTRIBUTES,
  ...RESOURCE_SRCSET_ATTRIBUTES,
  'style',
];
const RESOURCE_SELECTOR = RESOURCE_ATTRIBUTES.map((name) => `[${name}]`).join(',');

function rewriteSrcset(value: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/);
      if (!match) return candidate;
      const [, leading, url, descriptor] = match;
      return `${leading}${rewriteSupabaseUrl(url)}${descriptor}`;
    })
    .join(',');
}

function rewriteCssUrls(value: string): string {
  return value.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (full, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const rawUrl = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();
      const rewritten = rewriteSupabaseUrl(rawUrl);
      if (rewritten === rawUrl) return full;
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
      return `url(${quote}${rewritten}${quote})`;
    },
  );
}

/**
 * Переписывает значение DOM-атрибута с ресурсом. Отдельный export нужен,
 * чтобы правила URL можно было проверить без реальной загрузки картинок.
 */
export function rewriteSupabaseResourceAttribute(name: string, value: string): string {
  if (!value.includes(SUPABASE_HOST)) return value;
  const normalizedName = name.toLowerCase();
  if (RESOURCE_URL_ATTRIBUTES.has(normalizedName)) return rewriteSupabaseUrl(value);
  if (RESOURCE_SRCSET_ATTRIBUTES.has(normalizedName)) return rewriteSrcset(value);
  if (normalizedName === 'style') return rewriteCssUrls(value);
  return value;
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
let originalSetAttribute: typeof Element.prototype.setAttribute | null = null;
let resourceObserver: MutationObserver | null = null;
let resourceProxyInstalled = false;

function rewriteElementAttribute(element: Element, attributeName: string) {
  if (!originalSetAttribute || !getProxyMode()) return;
  const current = element.getAttribute(attributeName);
  if (current === null) return;
  const rewritten = rewriteSupabaseResourceAttribute(attributeName, current);
  if (rewritten !== current) {
    originalSetAttribute.call(element, attributeName, rewritten);
  }
}

function rewriteResourceTree(root: Node) {
  if (!getProxyMode() || typeof Element === 'undefined') return;

  if (root instanceof Element) {
    for (const attributeName of RESOURCE_ATTRIBUTES) {
      if (root.hasAttribute(attributeName)) rewriteElementAttribute(root, attributeName);
    }
  }

  if ('querySelectorAll' in root) {
    const parent = root as ParentNode;
    parent.querySelectorAll?.(RESOURCE_SELECTOR).forEach((element) => {
      for (const attributeName of RESOURCE_ATTRIBUTES) {
        if (element.hasAttribute(attributeName)) rewriteElementAttribute(element, attributeName);
      }
    });
  }
}

function patchUrlProperty(prototype: object, propertyName: string, attributeName: string) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
  if (!descriptor?.get || !descriptor.set || descriptor.configurable === false) return;

  Object.defineProperty(prototype, propertyName, {
    ...descriptor,
    set(value: unknown) {
      const stringValue = String(value);
      const rewritten = getProxyMode()
        ? rewriteSupabaseResourceAttribute(attributeName, stringValue)
        : stringValue;
      descriptor.set!.call(this, rewritten);
    },
  });
}

function installResourceProxy() {
  if (resourceProxyInstalled || typeof window === 'undefined' || typeof Element === 'undefined') return;
  resourceProxyInstalled = true;

  originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name: string, value: string) {
    const stringValue = String(value);
    const rewritten = getProxyMode()
      ? rewriteSupabaseResourceAttribute(name, stringValue)
      : stringValue;
    return originalSetAttribute!.call(this, name, rewritten);
  };

  // React обычно использует setAttribute, но прямые присваивания вида img.src
  // и video.poster тоже должны сразу получать URL прокси, без первой неудачной
  // попытки обращения к заблокированному Supabase.
  const propertyTargets: Array<[object | undefined, string, string]> = [
    [typeof HTMLImageElement !== 'undefined' ? HTMLImageElement.prototype : undefined, 'src', 'src'],
    [typeof HTMLImageElement !== 'undefined' ? HTMLImageElement.prototype : undefined, 'srcset', 'srcset'],
    [typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : undefined, 'src', 'src'],
    [typeof HTMLSourceElement !== 'undefined' ? HTMLSourceElement.prototype : undefined, 'src', 'src'],
    [typeof HTMLSourceElement !== 'undefined' ? HTMLSourceElement.prototype : undefined, 'srcset', 'srcset'],
    [typeof HTMLVideoElement !== 'undefined' ? HTMLVideoElement.prototype : undefined, 'poster', 'poster'],
    [typeof HTMLIFrameElement !== 'undefined' ? HTMLIFrameElement.prototype : undefined, 'src', 'src'],
    [typeof HTMLAnchorElement !== 'undefined' ? HTMLAnchorElement.prototype : undefined, 'href', 'href'],
    [typeof HTMLObjectElement !== 'undefined' ? HTMLObjectElement.prototype : undefined, 'data', 'data'],
  ];
  propertyTargets.forEach(([prototype, propertyName, attributeName]) => {
    if (prototype) patchUrlProperty(prototype, propertyName, attributeName);
  });

  if (typeof CSSStyleDeclaration !== 'undefined') {
    for (const propertyName of [
      'background',
      'backgroundImage',
      'borderImage',
      'borderImageSource',
      'listStyle',
      'listStyleImage',
      'mask',
      'maskImage',
    ]) {
      patchUrlProperty(CSSStyleDeclaration.prototype, propertyName, 'style');
    }
  }

  const startObserver = () => {
    if (resourceObserver || !document.documentElement || typeof MutationObserver === 'undefined') return;
    resourceObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof Element && mutation.attributeName) {
          rewriteElementAttribute(mutation.target, mutation.attributeName);
        } else if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(rewriteResourceTree);
        }
      }
    });
    resourceObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: RESOURCE_ATTRIBUTES,
    });
    rewriteResourceTree(document.documentElement);
  };

  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  window.addEventListener('sintagma:proxy-activated', () => {
    if (document.documentElement) rewriteResourceTree(document.documentElement);
  });
}

export function installProxyFetch() {
  if (typeof window === 'undefined') return;

  // img/video/audio/background-image не используют window.fetch, поэтому их
  // URL перехватываются отдельно до первого рендера React.
  installResourceProxy();

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
        const proxyUrl = rewriteSupabaseUrl(urlStr);
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
          const proxyUrl = rewriteSupabaseUrl(urlStr);
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
