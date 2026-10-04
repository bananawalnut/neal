import { Buffer } from 'buffer/';

Object.assign(globalThis, { Buffer });

const { loadRuntimeConfig } = await import('./runtime-config');
try {
  await loadRuntimeConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : 'The manual acceptance runtime is unavailable.';
  document.documentElement.dataset.acceptanceBlocked = 'true';
  document.body.innerHTML = `
    <main style="max-width:760px;margin:10vh auto;padding:28px;border:5px solid #111;background:#ffdf00;color:#111;box-shadow:12px 12px 0 #2155ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <strong style="display:block;font-size:14px;letter-spacing:.08em">ACCEPTANCE RUNTIME UNAVAILABLE</strong>
      <h1 style="font-size:clamp(36px,8vw,72px);line-height:.9">NO TEST TRANSACTIONS CAN RUN.</h1>
      <p style="font-weight:800;line-height:1.5"></p>
      <small>Run the manual-devnet status and verify commands. This page will not fall back to production terms.</small>
    </main>`;
  const paragraph = document.querySelector('p');
  if (paragraph) paragraph.textContent = message;
  throw error;
}

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
