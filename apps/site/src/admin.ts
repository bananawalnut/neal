import './admin.css';

const HOMESERVER = 'https://matrix.nealtheseal.org';
const SERVER_NAME = 'matrix.nealtheseal.org';
const ROOM_ALIAS = '#neal-gc:matrix.nealtheseal.org';
const ROOM_ID = '!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org';
const HERMES_USER_ID = '@neal:matrix.nealtheseal.org';
const HERMES_FRESH_MS = 150_000;
const REFRESH_MS = 30_000;
const USE_LOCAL_ADMIN_MONITOR_PROXY = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
const ADMIN_API_ORIGIN = USE_LOCAL_ADMIN_MONITOR_PROXY ? '' : HOMESERVER;

type BrokerSession = {
  schema?: unknown;
  userId: string;
};

type SynapseUser = {
  name?: unknown;
  admin?: unknown;
  deactivated?: unknown;
  locked?: unknown;
  is_guest?: unknown;
};

type SynapseUsersResponse = {
  users?: unknown;
  total?: unknown;
};

type MatrixStateEvent = {
  type?: unknown;
  state_key?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
};

type HermesHealth = {
  status?: unknown;
  observed_at?: unknown;
  profile?: unknown;
  user_id?: unknown;
  room_id?: unknown;
  gateway_version?: unknown;
  service_managed?: unknown;
};

type AdminSnapshot = {
  schema?: unknown;
  session?: unknown;
  server?: unknown;
  users?: unknown;
  alias?: unknown;
  state?: unknown;
  hermes?: unknown;
  generatedAt?: unknown;
};

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const app = document.querySelector<HTMLDivElement>('#admin-app');
if (!app) throw new Error('Missing #admin-app');

app.innerHTML = `
  <div class="admin-shell">
    <header class="admin-topbar">
      <a class="admin-brand" href="/" aria-label="Return to Neal the Seal">
        <img src="/neal-favicon.png" width="44" height="44" alt="" />
        <span><strong>NEAL</strong><small>ADMIN MONITOR</small></span>
      </a>
      <p class="admin-topbar__status" id="topbar-status">SIGNED OUT</p>
    </header>
    <main class="admin-main">
      <section class="admin-intro" aria-labelledby="admin-title">
        <p class="admin-kicker">Read-only operations</p>
        <h1 id="admin-title">Know what is online.</h1>
        <p>Monitor the Neal homeserver, its local accounts, the canonical room, and the local Hermes gateway. This page cannot change accounts, members, or messages.</p>
      </section>

      <form class="admin-login" id="admin-login">
        <h2>Administrator sign in</h2>
        <p>Credentials are verified by the Neal monitor. Its short-lived Matrix session is encrypted server-side and never exposed to this page.</p>
        <label><span>NEAL USERNAME</span><input id="admin-username" name="username" autocomplete="username" placeholder="beaver" required /></label>
        <label><span>PASSWORD</span><input id="admin-password" name="password" type="password" autocomplete="current-password" required /></label>
        <button id="admin-login-button" type="submit">SIGN IN AND LOAD STATUS</button>
      </form>

      <p class="admin-status" id="admin-status" role="status" data-state="idle">Sign in with a local Neal administrator account.</p>

      <section class="admin-dashboard" id="admin-dashboard" aria-label="System monitor" hidden>
        <div class="admin-toolbar">
          <p id="last-updated">Not refreshed yet</p>
          <div class="admin-toolbar__actions">
            <button class="admin-action admin-action--quiet" id="auto-refresh" type="button" aria-pressed="true">AUTO REFRESH ON</button>
            <button class="admin-action" id="refresh" type="button">REFRESH NOW</button>
            <button class="admin-action admin-action--quiet" id="admin-logout" type="button">SIGN OUT</button>
          </div>
        </div>

        <div class="admin-summary" aria-label="Current summary">
          <article><span>Homeserver</span><strong id="summary-server">—</strong><small id="summary-version">Waiting for status</small></article>
          <article><span>Active accounts</span><strong id="summary-accounts">—</strong><small id="summary-admins">Waiting for status</small></article>
          <article><span>Room members</span><strong id="summary-members">—</strong><small id="summary-federated">Waiting for status</small></article>
          <article><span>Hermes gateway</span><strong id="summary-hermes">—</strong><small id="summary-heartbeat">Waiting for status</small></article>
        </div>

        <div class="admin-grid">
          <div class="admin-stack">
            <section class="admin-panel" aria-labelledby="accounts-title">
              <div class="admin-panel__head"><div><h2 id="accounts-title">Local accounts</h2><p>Matrix IDs, roles, and account state only.</p></div><span class="admin-badge admin-badge--neutral" id="accounts-count">—</span></div>
              <div id="accounts-content"><p class="admin-empty">Waiting for status.</p></div>
              <details class="admin-details" id="deactivated-details"><summary id="deactivated-summary">Deactivated service accounts</summary><ul id="deactivated-list"></ul></details>
            </section>

            <section class="admin-panel admin-panel--requests" aria-labelledby="requests-title">
              <div class="admin-panel__head"><div><h2 id="requests-title">Membership requests</h2><p>Accounts waiting to enter the canonical Neal room.</p></div><span class="admin-badge admin-badge--neutral" id="requests-count">—</span></div>
              <div id="requests-content" aria-live="polite"><p class="admin-empty">Waiting for status.</p></div>
            </section>

            <section class="admin-panel" aria-labelledby="members-title">
              <div class="admin-panel__head"><div><h2 id="members-title">Federated room members</h2><p>Accounts joined from homeservers outside Neal.</p></div><span class="admin-badge admin-badge--neutral" id="members-count">—</span></div>
              <div id="members-content"><p class="admin-empty">Waiting for status.</p></div>
            </section>
          </div>

          <div class="admin-stack">
            <section class="admin-panel" aria-labelledby="hermes-title">
              <div class="admin-panel__head"><div><h2 id="hermes-title">Hermes</h2><p>Local gateway heartbeat and room binding.</p></div></div>
              <div class="admin-agent">
                <div class="admin-agent__state"><span class="admin-agent__dot" id="hermes-dot"></span><strong id="hermes-state">Waiting for status</strong></div>
                <dl>
                  <dt>Identity</dt><dd><code>${HERMES_USER_ID}</code></dd>
                  <dt>Room</dt><dd><code>${ROOM_ID}</code></dd>
                  <dt>Last heartbeat</dt><dd id="hermes-observed">—</dd>
                  <dt>Gateway version</dt><dd id="hermes-version">—</dd>
                  <dt>Service manager</dt><dd id="hermes-service">—</dd>
                </dl>
              </div>
            </section>

            <section class="admin-panel" aria-labelledby="checks-title">
              <div class="admin-panel__head"><div><h2 id="checks-title">Room checks</h2><p>Expected policy for the canonical Neal GC.</p></div></div>
              <ul class="admin-list" id="checks-list"><li><span>Waiting for status.</span></li></ul>
            </section>

            <section class="admin-panel" aria-labelledby="membership-title">
              <div class="admin-panel__head"><div><h2 id="membership-title">Membership</h2><p>Current room entry states.</p></div></div>
              <ul class="admin-list" id="membership-list"><li><span>Waiting for status.</span></li></ul>
            </section>
          </div>
        </div>
      </section>
    </main>
  </div>
`;

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing admin control: ${selector}`);
  return element;
};

const loginForm = required<HTMLFormElement>('#admin-login');
const usernameInput = required<HTMLInputElement>('#admin-username');
const passwordInput = required<HTMLInputElement>('#admin-password');
const loginButton = required<HTMLButtonElement>('#admin-login-button');
const dashboard = required<HTMLElement>('#admin-dashboard');
const status = required<HTMLElement>('#admin-status');
const topbarStatus = required<HTMLElement>('#topbar-status');
const refreshButton = required<HTMLButtonElement>('#refresh');
const autoRefreshButton = required<HTMLButtonElement>('#auto-refresh');
const logoutButton = required<HTMLButtonElement>('#admin-logout');

let activeSession: BrokerSession | null = null;
let autoRefresh = true;
let refreshTimer: number | null = null;

const asRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
);

const asString = (value: unknown): string => typeof value === 'string' ? value : '';
const asBoolean = (value: unknown): boolean => value === true || value === 1;
const escapeHtml = (value: unknown): string => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const setStatus = (message: string, state: 'idle' | 'working' | 'good' | 'bad' = 'idle'): void => {
  status.textContent = message;
  status.dataset.state = state;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'The status request failed.';

const readError = async (response: Response): Promise<string> => {
  try {
    const payload = asRecord(await response.json());
    return asString(payload.message) || asString(payload.error) || `Monitor returned HTTP ${response.status}.`;
  } catch {
    return `Matrix returned HTTP ${response.status}.`;
  }
};

const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${ADMIN_API_ORIGIN}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new RequestError(response.status, await readError(response));
  return await response.json() as T;
};

const clearSession = (): void => {
  activeSession = null;
};

const badge = (label: string, state: 'good' | 'warn' | 'bad' | 'neutral'): string => (
  `<span class="admin-badge admin-badge--${state}">${escapeHtml(label)}</span>`
);

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Invalid timestamp';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
};

const relativeTime = (value: string): string => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown age';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

const eventContent = (events: MatrixStateEvent[], type: string, stateKey = ''): Record<string, unknown> | null => {
  const event = events.find((candidate) => candidate.type === type && candidate.state_key === stateKey);
  return event ? asRecord(event.content) : null;
};

const renderAccounts = (payload: SynapseUsersResponse): { active: number; admins: number; deactivated: number } => {
  const users = Array.isArray(payload.users) ? payload.users.map((value) => asRecord(value) as SynapseUser) : [];
  const active = users.filter((user) => !asBoolean(user.deactivated));
  const deactivated = users.filter((user) => asBoolean(user.deactivated));
  const admins = active.filter((user) => asBoolean(user.admin));
  const activeRows = active.map((user) => {
    const id = asString(user.name) || 'Unknown account';
    const role = asBoolean(user.admin)
      ? badge('Administrator', 'good')
      : asBoolean(user.is_guest) ? badge('Guest', 'warn') : badge('User', 'neutral');
    const accountState = asBoolean(user.locked) ? badge('Locked', 'bad') : badge('Active', 'good');
    return `<tr><td><code>${escapeHtml(id)}</code></td><td>${role}</td><td>${accountState}</td></tr>`;
  }).join('');
  required<HTMLElement>('#accounts-content').innerHTML = activeRows
    ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Matrix ID</th><th>Role</th><th>Status</th></tr></thead><tbody>${activeRows}</tbody></table></div>`
    : '<p class="admin-empty">No active local accounts were returned.</p>';
  required<HTMLElement>('#accounts-count').textContent = `${active.length} ACTIVE`;
  const list = required<HTMLUListElement>('#deactivated-list');
  list.innerHTML = deactivated.map((user) => `<li><code>${escapeHtml(asString(user.name) || 'Unknown account')}</code></li>`).join('');
  required<HTMLElement>('#deactivated-summary').textContent = `${deactivated.length} deactivated service account${deactivated.length === 1 ? '' : 's'}`;
  required<HTMLDetailsElement>('#deactivated-details').hidden = deactivated.length === 0;
  return { active: active.length, admins: admins.length, deactivated: deactivated.length };
};

const renderMembers = (events: MatrixStateEvent[]): { joined: number; federated: number; invite: number; knock: number } => {
  const memberEvents = events.filter((event) => event.type === 'm.room.member' && typeof event.state_key === 'string');
  const membership = (event: MatrixStateEvent): string => asString(asRecord(event.content).membership);
  const joined = memberEvents.filter((event) => membership(event) === 'join');
  const federated = joined.filter((event) => !asString(event.state_key).endsWith(`:${SERVER_NAME}`));
  const invited = memberEvents.filter((event) => membership(event) === 'invite');
  const knocking = memberEvents
    .filter((event) => membership(event) === 'knock')
    .sort((left, right) => Number(right.origin_server_ts) - Number(left.origin_server_ts));
  const requestRows = knocking.map((event) => {
    const id = asString(event.state_key);
    const server = id.slice(id.lastIndexOf(':') + 1) || 'Unknown';
    const timestamp = Number(event.origin_server_ts);
    const requestedAt = Number.isFinite(timestamp) && timestamp > 0
      ? formatTime(new Date(timestamp).toISOString())
      : 'Not reported';
    return `<tr><td><code>${escapeHtml(id)}</code></td><td>${escapeHtml(server)}</td><td>${escapeHtml(requestedAt)}</td><td>${badge('Waiting', 'warn')}</td></tr>`;
  }).join('');
  required<HTMLElement>('#requests-content').innerHTML = requestRows
    ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Matrix ID</th><th>Homeserver</th><th>Requested</th><th>Status</th></tr></thead><tbody>${requestRows}</tbody></table></div>`
    : '<p class="admin-empty admin-empty--good">No pending membership requests.</p>';
  required<HTMLElement>('#requests-count').textContent = `${knocking.length} WAITING`;
  required<HTMLElement>('#requests-count').className = `admin-badge admin-badge--${knocking.length ? 'warn' : 'good'}`;
  const rows = federated.map((event) => {
    const id = asString(event.state_key);
    const server = id.slice(id.lastIndexOf(':') + 1);
    return `<tr><td><code>${escapeHtml(id)}</code></td><td>${escapeHtml(server)}</td><td>${badge('Joined', 'good')}</td></tr>`;
  }).join('');
  required<HTMLElement>('#members-content').innerHTML = rows
    ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Matrix ID</th><th>Homeserver</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="admin-empty">No joined federated accounts were returned.</p>';
  required<HTMLElement>('#members-count').textContent = `${federated.length} FEDERATED`;
  required<HTMLElement>('#membership-list').innerHTML = [
    ['Joined', joined.length, 'good'],
    ['Waiting to enter', knocking.length, knocking.length ? 'warn' : 'neutral'],
    ['Invited', invited.length, invited.length ? 'warn' : 'neutral'],
  ].map(([label, count, state]) => `<li><span>${escapeHtml(label)}</span>${badge(String(count), state as 'good' | 'warn' | 'neutral')}</li>`).join('');
  return { joined: joined.length, federated: federated.length, invite: invited.length, knock: knocking.length };
};

const renderChecks = (events: MatrixStateEvent[], aliasRoomId: string): void => {
  const encryption = events.some((event) => event.type === 'm.room.encryption');
  const history = asString(eventContent(events, 'm.room.history_visibility')?.history_visibility);
  const joinRule = asString(eventContent(events, 'm.room.join_rules')?.join_rule);
  const guestAccess = asString(eventContent(events, 'm.room.guest_access')?.guest_access);
  const checks: Array<[string, string, boolean]> = [
    ['Canonical alias', aliasRoomId === ROOM_ID ? 'Points to the recorded room' : 'Does not match the recorded room', aliasRoomId === ROOM_ID],
    ['Encryption', encryption ? 'Unexpected encryption event present' : 'Off as expected for the public GC', !encryption],
    ['History', history || 'Not reported', history === 'world_readable'],
    ['Room entry', joinRule || 'Not reported', joinRule === 'knock'],
    ['Guest joining', guestAccess || 'Not reported', guestAccess === 'forbidden'],
  ];
  required<HTMLElement>('#checks-list').innerHTML = checks.map(([label, detail, passed]) => (
    `<li class="admin-check"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>${badge(passed ? 'Pass' : 'Review', passed ? 'good' : 'warn')}</li>`
  )).join('');
};

const renderHermes = (health: HermesHealth | null, events: MatrixStateEvent[]): 'online' | 'stale' | 'offline' => {
  const membership = eventContent(events, 'm.room.member', HERMES_USER_ID);
  const joined = asString(membership?.membership) === 'join';
  const observedAt = asString(health?.observed_at);
  const observedTime = new Date(observedAt).getTime();
  const fresh = Number.isFinite(observedTime) && Date.now() - observedTime <= HERMES_FRESH_MS;
  const correctBinding = health?.user_id === HERMES_USER_ID && health?.room_id === ROOM_ID;
  const reportedOnline = health?.status === 'online';
  const state = joined && fresh && correctBinding && reportedOnline ? 'online' : joined && health ? 'stale' : 'offline';
  const stateLabel = state === 'online' ? 'Online' : state === 'stale' ? 'Heartbeat stale' : 'Not reporting';
  const tone = state === 'online' ? 'good' : state === 'stale' ? 'warn' : 'bad';
  required<HTMLElement>('#hermes-state').textContent = stateLabel;
  required<HTMLElement>('#hermes-dot').dataset.state = tone;
  required<HTMLElement>('#hermes-observed').textContent = observedAt ? `${formatTime(observedAt)} · ${relativeTime(observedAt)}` : 'No heartbeat found';
  required<HTMLElement>('#hermes-version').textContent = asString(health?.gateway_version) || 'Not reported';
  required<HTMLElement>('#hermes-service').textContent = health ? (asBoolean(health.service_managed) ? 'Managed' : 'Detached') : 'Not reported';
  return state;
};

const refresh = async (quietUnauthorized = false): Promise<void> => {
  refreshButton.disabled = true;
  setStatus('Refreshing the monitor…', 'working');
  try {
    const payload = await requestJson<AdminSnapshot>('/_neal/admin/snapshot');
    if (payload.schema !== 'neal.admin-snapshot/v1') throw new Error('The monitor returned an unsupported snapshot.');
    const sessionPayload = asRecord(payload.session);
    const userId = asString(sessionPayload.userId);
    if (!userId.endsWith(`:${SERVER_NAME}`)) throw new Error('The monitor returned an invalid administrator session.');
    const session = { schema: 'neal.admin-session/v1', userId };
    activeSession = session;
    showDashboard(session);
    const users = asRecord(payload.users) as SynapseUsersResponse;
    const server = asRecord(payload.server);
    const alias = asRecord(payload.alias);
    const events = Array.isArray(payload.state) ? payload.state.map((item) => asRecord(item) as MatrixStateEvent) : [];
    const health = asRecord(payload.hermes) as HermesHealth;

    const accounts = renderAccounts(users);
    required<HTMLElement>('#summary-accounts').textContent = String(accounts.active);
    required<HTMLElement>('#summary-admins').textContent = `${accounts.admins} administrator${accounts.admins === 1 ? '' : 's'}`;

    const serverVersion = asString(server.server_version);
    required<HTMLElement>('#summary-server').textContent = 'Online';
    required<HTMLElement>('#summary-version').textContent = serverVersion ? `Synapse ${serverVersion}` : 'Version not reported';

    const memberSummary = renderMembers(events);
    required<HTMLElement>('#summary-members').textContent = String(memberSummary.joined);
    required<HTMLElement>('#summary-federated').textContent = `${memberSummary.federated} federated · ${memberSummary.knock} waiting`;

    renderChecks(events, asString(alias.room_id));
    const hermesState = renderHermes(health, events);
    required<HTMLElement>('#summary-hermes').textContent = hermesState === 'online' ? 'Online' : hermesState === 'stale' ? 'Stale' : 'Offline';
    required<HTMLElement>('#summary-heartbeat').textContent = asString(health.observed_at)
      ? `Heartbeat ${relativeTime(asString(health.observed_at))}`
      : 'No current heartbeat';

    const updated = typeof payload.generatedAt === 'number'
      ? new Date(payload.generatedAt * 1000).toISOString()
      : new Date().toISOString();
    required<HTMLElement>('#last-updated').textContent = `Last updated ${formatTime(updated)}`;
    topbarStatus.textContent = `${session.userId} · MONITORING`;
    setStatus('All requested monitoring data loaded.', 'good');
    scheduleRefresh();
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) {
      clearSession();
      showSignedOut();
      if (!quietUnauthorized) setStatus('Administrator session expired. Sign in again.', 'bad');
    } else {
      setStatus(errorMessage(error), 'bad');
    }
  } finally {
    refreshButton.disabled = false;
  }
};

const scheduleRefresh = (): void => {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (autoRefresh && activeSession) refreshTimer = window.setTimeout(() => void refresh(), REFRESH_MS);
};

const showDashboard = (session: BrokerSession): void => {
  activeSession = session;
  loginForm.hidden = true;
  dashboard.hidden = false;
  topbarStatus.textContent = `${session.userId} · LOADING`;
};

const showSignedOut = (): void => {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
  loginForm.hidden = false;
  dashboard.hidden = true;
  topbarStatus.textContent = 'SIGNED OUT';
};

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  let password = passwordInput.value;
  try {
    setStatus('Signing in through the protected Neal monitor…', 'working');
    const session = await requestJson<BrokerSession>('/_neal/admin/session', {
      method: 'POST',
      body: JSON.stringify({
        schema: 'neal.admin-session-request/v1',
        username: usernameInput.value.trim(),
        password,
      }),
    });
    password = '';
    passwordInput.value = '';
    if (session.schema !== 'neal.admin-session/v1' || !session.userId.endsWith(`:${SERVER_NAME}`)) {
      throw new Error('The monitor returned an invalid administrator session.');
    }
    showDashboard(session);
    await refresh();
  } catch (error) {
    setStatus(errorMessage(error), 'bad');
  } finally {
    password = '';
    passwordInput.value = '';
    loginButton.disabled = false;
  }
});

refreshButton.addEventListener('click', () => void refresh());

autoRefreshButton.addEventListener('click', () => {
  autoRefresh = !autoRefresh;
  autoRefreshButton.textContent = `AUTO REFRESH ${autoRefresh ? 'ON' : 'PAUSED'}`;
  autoRefreshButton.setAttribute('aria-pressed', String(autoRefresh));
  scheduleRefresh();
});

logoutButton.addEventListener('click', async () => {
  clearSession();
  showSignedOut();
  setStatus('Signed out. The broker is revoking its Matrix session.', 'good');
  try {
    await requestJson('/_neal/admin/session', { method: 'DELETE' });
  } catch {
    // The opaque browser cookie is cleared by the broker even if Matrix is unavailable.
  }
});

setStatus('Checking for an existing secure monitor session…', 'working');
void refresh(true).then(() => {
  if (!activeSession) setStatus('Sign in with the Beaver administrator account.', 'idle');
});
