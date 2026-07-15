import "./index.css";
import { installProxyFetch } from "./utils/proxyFetch";

// Перехватчик API, WebSocket и облачных ресурсов Supabase. В Android всё
// направляется через публичный Nginx-прокси до первого рендера приложения.
installProxyFetch();

// Cyrillic domain (синтагма.рф) больше НЕ редиректится автоматически —
// пользователь сам решает, куда направить DNS этого домена (Timeweb / Lovable / Worker).
// Если домен подключён к Lovable, сайт открывается напрямую; если DNS ведёт на Timeweb —
// откроется тот деплой. Если в будущем нужно вернуть редирект, восстановите блок из истории.

declare const __BUILD_TIMESTAMP__: string;

const isNative = typeof (window as any).Capacitor !== 'undefined';
const isPreview = window.location.hostname.includes('preview--') || window.location.hostname === 'localhost';

const BUILD_GUARD_KEY = '__build_refresh_guard';
const REMOTE_GUARD_KEY = '__remote_refresh_guard';
const currentVersion = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : 'dev';

// Expose build version globally for diagnostics
(window as any).__BUILD_VERSION__ = currentVersion;

// Skip build-version reload if bootstrap already did a session-guard reload
const bootstrapJustReloaded = isPreview && sessionStorage.getItem('__purge_preview_session') === '1';

async function purgeAllCaches() {
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  }
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();
  }
}

(async () => {
  // Build version check (second line of defense — skip if bootstrap just reloaded)
  if (!bootstrapJustReloaded) {
    const storedVersion = localStorage.getItem('app-version');
    if (storedVersion !== null && storedVersion !== currentVersion) {
      const guard = sessionStorage.getItem(BUILD_GUARD_KEY);
      if (guard !== currentVersion) {
        await purgeAllCaches();
        localStorage.setItem('app-version', currentVersion);
        sessionStorage.setItem(BUILD_GUARD_KEY, currentVersion);
        window.location.reload();
        return;
      }
      sessionStorage.removeItem(BUILD_GUARD_KEY);
    }
  }

  localStorage.setItem('app-version', currentVersion);

  // Remote cache version check (admin-triggered forced refresh)
  try {
    const { checkRemoteCacheVersion } = await import('./utils/remoteCacheCheck');
    const needsReload = await checkRemoteCacheVersion();
    if (needsReload) {
      const guard = sessionStorage.getItem(REMOTE_GUARD_KEY);
      if (guard !== currentVersion) {
        await purgeAllCaches();
        sessionStorage.setItem(REMOTE_GUARD_KEY, currentVersion);
        window.location.reload();
        return;
      }
      sessionStorage.removeItem(REMOTE_GUARD_KEY);
    }
  } catch {
    // Silently ignore — DB might be unreachable
  }

  // Register SW only on production (not preview, not native)
  if (!isNative && !isPreview && import.meta.env.PROD) {
    import('virtual:pwa-register').then(({ registerSW }) => {
      const updateSW = registerSW({
        immediate: true,
        onNeedRefresh() {
          updateSW(true);
        },
        onRegistered(registration) {
          if (registration) {
            setInterval(() => registration.update(), 30 * 1000);
          }
        },
      });
    }).catch(() => {});
  }
})();

async function bootstrapApp() {
  const [{ createRoot }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("./App.tsx"),
  ]);

  const root = document.getElementById("root")!;
  createRoot(root).render(<App />);
}

void bootstrapApp();
