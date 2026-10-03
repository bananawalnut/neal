import { Buffer } from 'buffer/';

Object.assign(globalThis, { Buffer });

const { loadRuntimeConfig } = await import('./runtime-config');
await loadRuntimeConfig();

const STALE_ASSET_RELOAD_KEY = 'neal.stale-asset-reload.v1';
const STALE_ASSET_RELOAD_WINDOW_MS = 30_000;

const claimStaleAssetReload = (): boolean => {
  try {
    const now = Date.now();
    const previousReload = Number(sessionStorage.getItem(STALE_ASSET_RELOAD_KEY) ?? 0);
    if (Number.isFinite(previousReload) && now - previousReload < STALE_ASSET_RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(STALE_ASSET_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
};

window.addEventListener('vite:preloadError', (event) => {
  if (!claimStaleAssetReload()) return;
  event.preventDefault();
  window.location.reload();
});

await import('./main');
