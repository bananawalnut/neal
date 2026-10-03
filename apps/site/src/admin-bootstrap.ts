import { Buffer } from 'buffer/';
import { getLocalSurfaceMode } from './runtime-config';
import './admin.css';

Object.assign(globalThis, { Buffer });

const surface = getLocalSurfaceMode();
if (surface !== 'production') {
  document.documentElement.dataset.localPreview = 'true';
  const app = document.querySelector<HTMLDivElement>('#admin-app');
  if (!app) throw new Error('Missing #admin-app');
  app.innerHTML = `
    <main class="admin-main">
      <section class="admin-panel" aria-labelledby="local-admin-disabled">
        <p class="admin-kicker">LOCAL UI PREVIEW</p>
        <h1 id="local-admin-disabled">ADMIN ACTIONS DISABLED</h1>
        <p>This local surface cannot accept administrator credentials, create sessions, or contact the production monitor.</p>
        <a class="admin-button" href="/">RETURN TO LOCAL PREVIEW</a>
      </section>
    </main>
  `;
} else {
  await import('./admin');
}
