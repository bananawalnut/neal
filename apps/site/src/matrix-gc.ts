import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';

const ROOM_ALIAS = '#neal-gc:matrix.nealtheseal.org';
const ROOM_ID = '!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org';
const ROOM_VIA_SERVERS = [
  'matrix.nealtheseal.org',
  'salix.host',
];
const DIRECT_HOMESERVER_BASE_URLS = new Map([
  ['matrix.nealtheseal.org', 'https://matrix.nealtheseal.org'],
]);
const PUBLIC_FEED_URL = 'https://matrix.nealtheseal.org/_neal/gc/messages';
const PUBLIC_REFRESH_MS = 10_000;
const NEAL_HOMESERVER_DOMAIN = 'matrix.nealtheseal.org';
const SESSION_KEY = 'neal.matrix.session.v1';
const SSO_PENDING_KEY = 'neal.matrix.sso.pending.v1';
const SSO_MAX_AGE_MS = 20 * 60 * 1000;
const MATRIX_SDK_LOAD_FAILURE = 'The chat client could not load. Check your connection, reload the page, then sign in again.';

type MatrixSdk = typeof import('matrix-js-sdk');

type MatrixSession = {
  baseUrl: string;
  accessToken: string;
  userId: string;
  deviceId: string;
};

type PendingSso = {
  baseUrl: string;
  domain: string;
  action: 'login' | 'register';
  state: string;
  createdAt: number;
};

type PublicMessage = {
  body: string;
  msgtype: string;
  sender: string;
  timestamp: number;
};

type ClientUi = {
  root: HTMLElement;
  entryTabs: HTMLElement;
  loginTab: HTMLButtonElement;
  createTab: HTMLButtonElement;
  loginForm: HTMLFormElement;
  userInput: HTMLInputElement;
  passwordInput: HTMLInputElement;
  loginButton: HTMLButtonElement;
  loginToggle: HTMLButtonElement;
  createToggle: HTMLButtonElement;
  ssoLoginButton: HTMLButtonElement;
  createForm: HTMLFormElement;
  createUsernameInput: HTMLInputElement;
  createIdOutput: HTMLOutputElement;
  createTokenInput: HTMLInputElement;
  createPasswordInput: HTMLInputElement;
  createConfirmInput: HTMLInputElement;
  createButton: HTMLButtonElement;
  logoutButton: HTMLButtonElement;
  status: HTMLElement;
  account: HTMLElement;
  memberState: HTMLElement;
  sessionPanel: HTMLElement;
  knockButton: HTMLButtonElement;
  joinButton: HTMLButtonElement;
  publicMessages: HTMLOListElement;
  messages: HTMLOListElement;
  composer: HTMLFormElement;
  messageInput: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  moderation: HTMLElement;
  knockList: HTMLUListElement;
};

type ActivityDockUi = {
  root: HTMLElement;
  state: HTMLElement;
  list: HTMLOListElement;
};

let activityDock: ActivityDockUi | null = null;
let publicRefreshTimer: number | null = null;

let sdkPromise: Promise<MatrixSdk> | null = null;

const isModuleLoadFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : '';
  return /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|load failed/i.test(message);
};

const loadSdk = (): Promise<MatrixSdk> => {
  sdkPromise ??= import('matrix-js-sdk').catch((error: unknown) => {
    sdkPromise = null;
    if (isModuleLoadFailure(error)) throw new Error(MATRIX_SDK_LOAD_FAILURE);
    throw error;
  });
  return sdkPromise;
};

const required = <T extends HTMLElement>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing Matrix client control: ${selector}`);
  return element;
};

const errorMessage = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const matrixError = error as { data?: { error?: unknown }; message?: unknown };
    if (typeof matrixError.data?.error === 'string') return matrixError.data.error;
    if (typeof matrixError.message === 'string') return matrixError.message;
  }
  return 'Matrix did not accept that request.';
};

export const parseMatrixId = (value: string): { userId: string; domain: string } => {
  const candidate = value.trim();
  if (!candidate.includes(':')) {
    const localpart = candidate.startsWith('@') ? candidate.slice(1) : candidate;
    if (!/^[a-z0-9._=\/-]+$/.test(localpart)) {
      throw new Error('Use your NEAL username, like neal, or a full Matrix ID.');
    }
    return {
      userId: `@${localpart}:${NEAL_HOMESERVER_DOMAIN}`,
      domain: NEAL_HOMESERVER_DOMAIN,
    };
  }
  const userId = candidate;
  const separator = userId.indexOf(':');
  if (!userId.startsWith('@') || separator < 2 || separator === userId.length - 1) {
    throw new Error('Use your NEAL username, like neal, or a full Matrix ID like @name:matrix.org.');
  }
  return { userId, domain: userId.slice(separator + 1) };
};

const normalizeHomeserverDomain = (value: string): string => {
  const candidate = value.trim().toLowerCase();
  if (!candidate) throw new Error('Enter a Matrix homeserver, like matrix.org.');
  if (candidate.includes('/') || candidate.includes('?') || candidate.includes('#') || candidate.includes('@')) {
    throw new Error('Use only the homeserver domain, like matrix.org.');
  }
  const parsed = new URL(`https://${candidate}/`);
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Use a valid Matrix homeserver domain.');
  }
  return parsed.host;
};

const saveSession = (session: MatrixSession): void => {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
};

const readSession = (): MatrixSession | null => {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MatrixSession>;
    if (
      typeof value.baseUrl === 'string'
      && typeof value.accessToken === 'string'
      && typeof value.userId === 'string'
      && typeof value.deviceId === 'string'
    ) return value as MatrixSession;
  } catch {
    // Invalid client state is discarded below.
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
};

const savePendingSso = (pending: PendingSso): void => {
  sessionStorage.setItem(SSO_PENDING_KEY, JSON.stringify(pending));
};

const readPendingSso = (): PendingSso | null => {
  const raw = sessionStorage.getItem(SSO_PENDING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingSso>;
    const parsed = typeof value.baseUrl === 'string' ? new URL(value.baseUrl) : null;
    if (
      parsed?.protocol === 'https:'
      && typeof value.domain === 'string'
      && (value.action === 'login' || value.action === 'register')
      && typeof value.state === 'string'
      && typeof value.createdAt === 'number'
      && Date.now() - value.createdAt <= SSO_MAX_AGE_MS
    ) return value as PendingSso;
  } catch {
    // Invalid or expired SSO state is discarded below.
  }
  sessionStorage.removeItem(SSO_PENDING_KEY);
  return null;
};

const setStatus = (ui: ClientUi, message: string, state: 'idle' | 'working' | 'good' | 'bad' = 'idle'): void => {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
};

const showEntryMode = (ui: ClientUi, mode: 'login' | 'create'): void => {
  const login = mode === 'login';
  ui.loginForm.hidden = !login;
  ui.createForm.hidden = login;
  ui.loginTab.setAttribute('aria-selected', String(login));
  ui.createTab.setAttribute('aria-selected', String(!login));
};

const clearList = (list: HTMLElement): void => list.replaceChildren();

const appendEmpty = (list: HTMLElement, copy: string): void => {
  const item = document.createElement('li');
  item.className = 'matrix-empty';
  item.textContent = copy;
  list.append(item);
};

const displayName = (room: Room, sender: string): string => room.getMember(sender)?.name || sender;

const publicDisplayName = (sender: string): string => {
  const separator = sender.indexOf(':');
  return sender.startsWith('@') && separator > 1 ? sender.slice(1, separator) : sender;
};

const setActivityDockState = (
  message: string,
  state: 'idle' | 'working' | 'good' | 'bad' = 'idle',
): void => {
  if (!activityDock) return;
  activityDock.state.textContent = message;
  activityDock.state.dataset.state = state;
  activityDock.root.dataset.state = state;
};

const activityGlyphs = (event: MatrixEvent): string => {
  const source = `${event.getId() ?? ''}:${event.getTs()}`;
  const palette = ['◆', '◇', '✦', '●', '▲', '▰'];
  let seed = 0;
  for (const character of source) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  return Array.from({ length: 5 }, (_, index) => palette[(seed + index * 7) % palette.length]).join(' ');
};

const renderActivityDock = (timeline: MatrixEvent[]): void => {
  if (!activityDock) return;
  const signals = timeline
    .filter((event) => event.getType() === 'm.room.message')
    .slice(-3)
    .reverse();
  clearList(activityDock.list);
  if (signals.length === 0) {
    const item = document.createElement('li');
    const symbols = document.createElement('b');
    const label = document.createElement('span');
    symbols.setAttribute('aria-hidden', 'true');
    symbols.textContent = '◇ ◇ ◇';
    label.textContent = 'NO ROOM SIGNALS ON THIS DEVICE YET';
    item.append(symbols, label);
    activityDock.list.append(item);
    setActivityDockState('CONNECTED · WAITING FOR ACTIVITY', 'good');
    return;
  }
  for (const event of signals) {
    const item = document.createElement('li');
    const symbols = document.createElement('b');
    const label = document.createElement('span');
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(event.getTs());
    symbols.setAttribute('aria-hidden', 'true');
    symbols.textContent = activityGlyphs(event);
    label.textContent = `ROOM MESSAGE · ${time}`;
    item.append(symbols, label);
    activityDock.list.append(item);
  }
  setActivityDockState(`${signals.length} RECENT MESSAGE${signals.length === 1 ? '' : 'S'} · LIVE`, 'good');
};

const renderPublicActivityDock = (messages: PublicMessage[]): void => {
  if (!activityDock) return;
  clearList(activityDock.list);
  const latest = messages.at(-1);
  if (!latest) {
    const item = document.createElement('li');
    const symbols = document.createElement('b');
    const label = document.createElement('span');
    symbols.setAttribute('aria-hidden', 'true');
    symbols.textContent = '◇ ◇ ◇';
    label.textContent = 'NO MESSAGES YET';
    item.append(symbols, label);
    activityDock.list.append(item);
    setActivityDockState('PUBLIC CHAT · WAITING FOR ACTIVITY', 'good');
    return;
  }
  const item = document.createElement('li');
  const symbols = document.createElement('b');
  const label = document.createElement('span');
  symbols.setAttribute('aria-hidden', 'true');
  symbols.textContent = '◆';
  label.textContent = `${publicDisplayName(latest.sender)}: ${latest.body}`;
  item.append(symbols, label);
  activityDock.list.append(item);
  setActivityDockState('PUBLIC CHAT · TAP TO READ', 'good');
};

const publicMessageFromEvent = (value: unknown): PublicMessage | null => {
  if (!value || typeof value !== 'object') return null;
  const event = value as {
    content?: {
      body?: unknown;
      msgtype?: unknown;
      'org.nealtheseal.public_history'?: unknown;
    };
    origin_server_ts?: unknown;
    sender?: unknown;
    type?: unknown;
  };
  if (
    event.type !== 'm.room.message'
    || typeof event.content?.body !== 'string'
    || typeof event.sender !== 'string'
    || typeof event.origin_server_ts !== 'number'
  ) return null;
  const archive = event.content['org.nealtheseal.public_history'];
  const original = archive && typeof archive === 'object' ? archive as {
    body?: unknown;
    sender?: unknown;
    timestamp?: unknown;
  } : null;
  return {
    body: typeof original?.body === 'string' ? original.body : event.content.body,
    msgtype: typeof event.content.msgtype === 'string' ? event.content.msgtype : 'm.text',
    sender: typeof original?.sender === 'string' ? original.sender : event.sender,
    timestamp: typeof original?.timestamp === 'number' ? original.timestamp : event.origin_server_ts,
  };
};

const renderPublicMessages = (ui: ClientUi, messages: PublicMessage[]): void => {
  clearList(ui.publicMessages);
  if (messages.length === 0) {
    appendEmpty(ui.publicMessages, 'NO MESSAGES YET. SIGN IN AND START THE RACKET.');
    renderPublicActivityDock(messages);
    return;
  }
  for (const message of messages) {
    const item = document.createElement('li');
    const name = publicDisplayName(message.sender);
    const avatar = document.createElement('span');
    const bubble = document.createElement('div');
    const meta = document.createElement('div');
    const author = document.createElement('strong');
    const time = document.createElement('time');
    const body = document.createElement('p');
    avatar.className = 'matrix-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
    bubble.className = 'matrix-bubble';
    author.textContent = name;
    time.dateTime = new Date(message.timestamp).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(message.timestamp);
    body.textContent = message.msgtype === 'm.emote' ? `* ${message.body}` : message.body;
    meta.append(author, time);
    bubble.append(meta, body);
    item.append(avatar, bubble);
    ui.publicMessages.append(item);
  }
  ui.publicMessages.scrollTop = ui.publicMessages.scrollHeight;
  renderPublicActivityDock(messages);
};

const refreshPublicMessages = async (ui: ClientUi): Promise<void> => {
  try {
    const response = await fetch(PUBLIC_FEED_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Public room feed returned ${response.status}.`);
    const payload = await response.json() as { chunk?: unknown };
    if (!Array.isArray(payload.chunk)) throw new Error('Public room feed returned no timeline.');
    const messages = payload.chunk
      .map(publicMessageFromEvent)
      .filter((message): message is PublicMessage => Boolean(message))
      .reverse();
    renderPublicMessages(ui, messages);
    if (!activeClient) setStatus(ui, 'Conversation is public. Sign in to send a message.', 'good');
  } catch {
    if (ui.publicMessages.childElementCount === 0 || ui.publicMessages.querySelector('.matrix-empty')) {
      clearList(ui.publicMessages);
      appendEmpty(ui.publicMessages, 'CHAT IS RECONNECTING…');
    }
    if (!activeClient) setStatus(ui, 'Could not load the public conversation. Retrying…', 'bad');
    setActivityDockState('PUBLIC CHAT · RECONNECTING', 'bad');
  }
};

const startPublicTimeline = (ui: ClientUi): void => {
  void refreshPublicMessages(ui);
  if (publicRefreshTimer !== null) return;
  publicRefreshTimer = window.setInterval(() => void refreshPublicMessages(ui), PUBLIC_REFRESH_MS);
};

const stopPublicTimeline = (): void => {
  if (publicRefreshTimer === null) return;
  window.clearInterval(publicRefreshTimer);
  publicRefreshTimer = null;
};

const renderMessages = (ui: ClientUi, client: MatrixClient, room: Room): void => {
  const timeline = room.getLiveTimeline().getEvents().slice(-60);
  if (client !== activeClient) return;
  renderActivityDock(timeline);
  clearList(ui.messages);
  const messages = timeline.filter((event) => event.getType() === 'm.room.message');
  if (messages.length === 0) {
    appendEmpty(ui.messages, 'NO MESSAGES ON THIS DEVICE YET. START THE RACKET.');
    return;
  }

  for (const event of messages) {
    const content = event.getContent() as { body?: unknown; msgtype?: unknown };
    if (typeof content.body !== 'string') continue;
    const sender = event.getSender() ?? 'UNKNOWN';
    const item = document.createElement('li');
    const name = displayName(room, sender);
    const avatar = document.createElement('span');
    const bubble = document.createElement('div');
    const meta = document.createElement('div');
    const author = document.createElement('strong');
    const time = document.createElement('time');
    const body = document.createElement('p');
    item.classList.toggle('matrix-message--own', sender === client.getUserId());
    avatar.className = 'matrix-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
    bubble.className = 'matrix-bubble';
    author.textContent = name;
    time.dateTime = new Date(event.getTs()).toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(event.getTs());
    body.textContent = content.msgtype === 'm.emote' ? `* ${content.body}` : content.body;
    meta.append(author, time);
    bubble.append(meta, body);
    item.append(avatar, bubble);
    ui.messages.append(item);
  }
  ui.messages.scrollTop = ui.messages.scrollHeight;
};

const renderModeration = (ui: ClientUi, client: MatrixClient, sdk: MatrixSdk, room: Room): void => {
  const userId = client.getUserId();
  const canInvite = Boolean(userId && room.canInvite(userId));
  const knocks = canInvite ? room.getMembersWithMembership(sdk.KnownMembership.Knock) : [];
  ui.moderation.hidden = !canInvite;
  clearList(ui.knockList);
  if (knocks.length === 0) {
    appendEmpty(ui.knockList, 'NO KNOCKS WAITING');
    return;
  }

  for (const member of knocks) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const admit = document.createElement('button');
    label.textContent = member.name || member.userId;
    admit.type = 'button';
    admit.textContent = 'ADMIT';
    admit.addEventListener('click', async () => {
      admit.disabled = true;
      setStatus(ui, `Admitting ${member.userId}…`, 'working');
      try {
        await client.invite(ROOM_ID, member.userId);
        setStatus(ui, `${member.userId} has been invited.`, 'good');
      } catch (error) {
        setStatus(ui, errorMessage(error), 'bad');
        admit.disabled = false;
      }
    });
    item.append(label, admit);
    ui.knockList.append(item);
  }
};

const renderRoom = async (ui: ClientUi, client: MatrixClient, sdk: MatrixSdk): Promise<void> => {
  if (client !== activeClient) return;
  const room = client.getRoom(ROOM_ID);
  const membership = room?.getMyMembership() ?? sdk.KnownMembership.Leave;
  ui.memberState.textContent = membership.toUpperCase();
  ui.knockButton.hidden = membership !== sdk.KnownMembership.Leave;
  ui.joinButton.hidden = membership !== sdk.KnownMembership.Invite;
  ui.composer.hidden = membership !== sdk.KnownMembership.Join;
  ui.messages.hidden = membership !== sdk.KnownMembership.Join;
  ui.publicMessages.hidden = membership === sdk.KnownMembership.Join;
  ui.moderation.hidden = true;

  if (membership === sdk.KnownMembership.Join && room) {
    stopPublicTimeline();
    setStatus(ui, 'Inside the NEAL GC.', 'good');
    setActivityDockState('SYNCING ROOM MESSAGES…', 'working');
    renderMessages(ui, client, room);
    renderModeration(ui, client, sdk, room);
  } else if (membership === sdk.KnownMembership.Knock) {
    startPublicTimeline(ui);
    setStatus(ui, 'Knock sent. A room moderator must admit you.', 'good');
    setActivityDockState('KNOCK SENT · WAITING AT THE DOOR', 'good');
  } else if (membership === sdk.KnownMembership.Invite) {
    startPublicTimeline(ui);
    setStatus(ui, 'The door is open. Accept the invite to enter.', 'good');
    setActivityDockState('INVITED · OPEN CHAT TO ENTER', 'good');
  } else {
    startPublicTimeline(ui);
    setStatus(ui, 'Authenticated. Knock to request entry.', 'idle');
    setActivityDockState('SIGNED IN · KNOCK TO SEE ACTIVITY', 'idle');
  }
};

let activeClient: MatrixClient | null = null;

const connectSession = async (ui: ClientUi, session: MatrixSession): Promise<void> => {
  const sdk = await loadSdk();
  activeClient?.stopClient();
  const client = sdk.createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
  });
  activeClient = client;
  ui.account.textContent = session.userId;
  ui.entryTabs.hidden = true;
  ui.loginForm.hidden = true;
  ui.loginToggle.hidden = true;
  ui.createToggle.hidden = true;
  ui.createForm.hidden = true;
  ui.sessionPanel.hidden = false;
  ui.logoutButton.hidden = false;
  setStatus(ui, 'Starting Matrix session…', 'working');
  setActivityDockState('CONNECTING TO THE ROOM…', 'working');

  client.on(sdk.RoomEvent.Timeline, (event: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined) => {
    if (!toStartOfTimeline && room?.roomId === ROOM_ID) void renderRoom(ui, client, sdk);
  });
  client.on(sdk.RoomEvent.MyMembership, (room: Room) => {
    if (room.roomId === ROOM_ID) void renderRoom(ui, client, sdk);
  });
  client.on(sdk.RoomStateEvent.Members, (_event, _state, member) => {
    if (member.roomId === ROOM_ID) void renderRoom(ui, client, sdk);
  });
  client.on(sdk.ClientEvent.Sync, (state) => {
    if (state === sdk.SyncState.Prepared || state === sdk.SyncState.Syncing) void renderRoom(ui, client, sdk);
    if (state === sdk.SyncState.Reconnecting) {
      setStatus(ui, 'Reconnecting to your homeserver…', 'working');
      setActivityDockState('RECONNECTING TO THE ROOM…', 'working');
    }
    if (state === sdk.SyncState.Error) {
      setStatus(ui, 'Matrix sync failed. Check the homeserver and try again.', 'bad');
      setActivityDockState('ROOM SIGNAL OFFLINE · OPEN CHAT', 'bad');
    }
  });

  try {
    await client.startClient({ initialSyncLimit: 60, lazyLoadMembers: true, disablePresence: true });
  } catch (error) {
    activeClient = null;
    client.stopClient();
    sessionStorage.removeItem(SESSION_KEY);
    ui.loginForm.hidden = false;
    ui.loginToggle.hidden = false;
    ui.createToggle.hidden = false;
    ui.publicMessages.hidden = false;
    ui.sessionPanel.hidden = true;
    ui.logoutButton.hidden = true;
    startPublicTimeline(ui);
    throw error;
  }
};

const discoverHomeserver = async (sdk: MatrixSdk, domain: string): Promise<string> => {
  const directBaseUrl = DIRECT_HOMESERVER_BASE_URLS.get(domain);
  if (directBaseUrl) {
    const response = await fetch(`${directBaseUrl}/_matrix/client/versions`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Could not verify the Matrix homeserver for ${domain}.`);
    return directBaseUrl;
  }

  const config = await sdk.AutoDiscovery.findClientConfig(domain);
  const baseUrl = config['m.homeserver'].base_url;
  if (config['m.homeserver'].state !== sdk.AutoDiscovery.SUCCESS || !baseUrl) {
    throw new Error(`Could not verify the Matrix homeserver for ${domain}.`);
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') throw new Error('The discovered homeserver is not HTTPS.');
  return parsed.toString().replace(/\/$/, '');
};

const beginSso = async (ui: ClientUi, domain: string, action: 'login' | 'register'): Promise<void> => {
  const sdk = await loadSdk();
  setStatus(ui, `Discovering ${domain}…`, 'working');
  const baseUrl = await discoverHomeserver(sdk, domain);
  const client = sdk.createClient({ baseUrl });
  const flows = await client.loginFlows();
  const flow = flows.flows.find((candidate) => candidate.type === 'm.login.sso')
    ?? flows.flows.find((candidate) => candidate.type === 'm.login.cas');
  if (!flow) {
    throw new Error(`${domain} does not advertise browser-based Matrix account access.`);
  }

  const state = crypto.randomUUID();
  const callback = new URL(window.location.href);
  callback.searchParams.delete('loginToken');
  callback.searchParams.set('matrixSso', state);
  callback.hash = 'gc';
  savePendingSso({ baseUrl, domain, action, state, createdAt: Date.now() });
  setStatus(ui, `${action === 'register' ? 'Opening account creation' : 'Opening secure sign-in'} at ${domain}…`, 'working');
  window.location.assign(client.getSsoLoginUrl(
    callback.toString(),
    flow.type === 'm.login.cas' ? 'cas' : 'sso',
    undefined,
    action === 'register' ? sdk.SSOAction.REGISTER : sdk.SSOAction.LOGIN,
  ));
};

type RegistrationResponse = {
  access_token?: unknown;
  device_id?: unknown;
  user_id?: unknown;
  session?: unknown;
  flows?: Array<{ stages?: unknown }>;
  completed?: unknown;
  errcode?: unknown;
  error?: unknown;
};

const registrationRequest = async (
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; payload: RegistrationResponse }> => {
  const response = await fetch(`${baseUrl}/_matrix/client/v3/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as RegistrationResponse;
  return { response, payload };
};

const requireRegistrationSession = (payload: RegistrationResponse): string => {
  if (typeof payload.session !== 'string' || !payload.session) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'The homeserver returned no registration session.');
  }
  return payload.session;
};

const registrationSession = (payload: RegistrationResponse, baseUrl: string): MatrixSession | null => {
  if (
    typeof payload.access_token !== 'string'
    || typeof payload.user_id !== 'string'
    || typeof payload.device_id !== 'string'
  ) return null;
  return {
    baseUrl,
    accessToken: payload.access_token,
    userId: payload.user_id,
    deviceId: payload.device_id,
  };
};

const registrationStages = (payload: RegistrationResponse): string[][] => (
  Array.isArray(payload.flows)
    ? payload.flows
      .map((flow) => Array.isArray(flow.stages) ? flow.stages.filter((stage): stage is string => typeof stage === 'string') : [])
      .filter((stages) => stages.length > 0)
    : []
);

const chooseRegistrationFlow = (payload: RegistrationResponse, token: string): string[] => {
  const flows = registrationStages(payload);
  const usable = flows.filter((stages) => (
    !stages.includes('m.login.email.identity')
    && !stages.includes('m.login.msisdn')
    && (stages.includes('m.login.recaptcha') || stages.includes('m.login.registration_token'))
    && (!stages.includes('m.login.registration_token') || Boolean(token))
  ));
  usable.sort((left, right) => {
    const score = (stages: string[]): number => (
      (stages.includes('m.login.recaptcha') ? 0 : 20)
      + (stages.includes('m.login.registration_token') ? 10 : 0)
      + stages.length
    );
    return score(left) - score(right);
  });
  if (usable[0]) return usable[0];
  if (!token && flows.some((stages) => stages.includes('m.login.registration_token'))) {
    throw new Error('This homeserver is currently invite-only. Open “Have a one-use invite token?” and enter a valid token.');
  }
  throw new Error('This homeserver does not offer a protected no-email registration flow this browser can complete.');
};

const waitForFallbackAuth = async (
  baseUrl: string,
  stage: string,
  session: string,
  preparedWindow: Window | null,
): Promise<void> => {
  const homeserver = new URL(baseUrl);
  const fallback = new URL(
    `/_matrix/client/v3/auth/${encodeURIComponent(stage)}/fallback/web`,
    homeserver,
  );
  fallback.searchParams.set('session', session);
  const popup = preparedWindow && !preparedWindow.closed
    ? preparedWindow
    : window.open('about:blank', 'neal-matrix-registration', 'popup,width=520,height=720');
  if (!popup) throw new Error('Allow the Matrix verification pop-up, then try creating the account again.');

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(closedTimer);
      window.clearTimeout(timeoutTimer);
      if (error && !popup.closed) popup.close();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== popup || event.origin !== homeserver.origin || event.data !== 'authDone') return;
      finish();
    };
    const closedTimer = window.setInterval(() => {
      if (popup.closed) finish(new Error('Matrix verification was closed before it finished.'));
    }, 500);
    const timeoutTimer = window.setTimeout(
      () => finish(new Error('Matrix verification expired. Start account creation again.')),
      10 * 60 * 1000,
    );
    window.addEventListener('message', onMessage);
    popup.location.replace(fallback.toString());
    popup.focus();
  });
};

const finishRegistration = async (ui: ClientUi, session: MatrixSession): Promise<void> => {
  saveSession(session);
  await connectSession(ui, session);
  const client = activeClient;
  if (!client) return;
  const membership = client.getRoom(ROOM_ID)?.getMyMembership();
  if (membership === 'join' || membership === 'invite' || membership === 'knock') {
    setStatus(ui, `Account created as ${session.userId}.`, 'good');
    return;
  }
  try {
    await client.knockRoom(ROOM_ID, {
      reason: 'New NEAL account requesting entry through the NEAL web client.',
      viaServers: ROOM_VIA_SERVERS,
    });
    ui.memberState.textContent = 'KNOCK';
    ui.knockButton.hidden = true;
    setStatus(ui, `Account created as ${session.userId}. Knock sent to the NEAL GC.`, 'good');
  } catch {
    setStatus(ui, `Account created as ${session.userId}. Use “Knock to join” when you are ready.`, 'good');
  }
};

const completeNativeRegistration = async (
  ui: ClientUi,
  baseUrl: string,
  username: string,
  password: string,
  token: string,
  preparedWindow: Window | null,
): Promise<void> => {
  const availability = await fetch(
    `${baseUrl}/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`,
    { headers: { Accept: 'application/json' } },
  );
  const availabilityPayload = await availability.json() as { available?: unknown; error?: unknown };
  if (!availability.ok || availabilityPayload.available !== true) {
    throw new Error(typeof availabilityPayload.error === 'string' ? availabilityPayload.error : 'That Matrix username is unavailable.');
  }

  const registrationBody = {
    username,
    password,
    initial_device_display_name: 'NEAL web GC',
  };
  let attempt = await registrationRequest(baseUrl, registrationBody);
  let session = registrationSession(attempt.payload, baseUrl);
  if (session) {
    preparedWindow?.close();
    await finishRegistration(ui, session);
    return;
  }
  if (attempt.response.status !== 401) {
    throw new Error(typeof attempt.payload.error === 'string' ? attempt.payload.error : 'The homeserver rejected account creation.');
  }

  const uiaSession = requireRegistrationSession(attempt.payload);
  const chosenFlow = chooseRegistrationFlow(attempt.payload, token);
  for (let stageCount = 0; stageCount < 8 && !session; stageCount += 1) {
    const completed = Array.isArray(attempt.payload.completed)
      ? attempt.payload.completed.filter((stage): stage is string => typeof stage === 'string')
      : [];
    const stage = chosenFlow.find((candidate) => !completed.includes(candidate));
    if (!stage) throw new Error('Matrix verification completed, but the homeserver did not create the account.');

    let auth: Record<string, unknown>;
    if (stage === 'm.login.registration_token') {
      if (!token) throw new Error('Enter the one-use invite token required by this homeserver.');
      auth = { type: stage, token, session: uiaSession };
    } else if (stage === 'm.login.dummy') {
      auth = { type: stage, session: uiaSession };
    } else {
      setStatus(ui, 'Complete the Matrix human-verification window to create your account…', 'working');
      await waitForFallbackAuth(baseUrl, stage, uiaSession, preparedWindow);
      auth = { session: uiaSession };
    }

    attempt = await registrationRequest(baseUrl, {
      ...registrationBody,
      auth,
    });
    session = registrationSession(attempt.payload, baseUrl);
    if (!session && attempt.response.status !== 401) {
      throw new Error(typeof attempt.payload.error === 'string' ? attempt.payload.error : 'The homeserver rejected account creation.');
    }
    const nowCompleted = Array.isArray(attempt.payload.completed)
      ? attempt.payload.completed.filter((candidate): candidate is string => typeof candidate === 'string')
      : [];
    if (!session && !nowCompleted.includes(stage)) {
      throw new Error(typeof attempt.payload.error === 'string' ? attempt.payload.error : 'Matrix did not accept that verification step.');
    }
  }
  if (!session) throw new Error('The homeserver did not finish account creation.');
  preparedWindow?.close();
  await finishRegistration(ui, session);
};

const consumeSsoCallback = async (ui: ClientUi): Promise<boolean> => {
  const callback = new URL(window.location.href);
  const loginToken = callback.searchParams.get('loginToken');
  if (!loginToken) return false;

  const returnedState = callback.searchParams.get('matrixSso');
  const pending = readPendingSso();
  callback.searchParams.delete('loginToken');
  callback.searchParams.delete('matrixSso');
  callback.hash = 'gc';
  window.history.replaceState(null, '', `${callback.pathname}${callback.search}${callback.hash}`);
  sessionStorage.removeItem(SSO_PENDING_KEY);

  if (!pending || !returnedState || pending.state !== returnedState) {
    throw new Error('That Matrix sign-in return was not initiated by this browser tab. Start again through NEAL.');
  }

  const sdk = await loadSdk();
  setStatus(ui, `Completing ${pending.domain} sign-in…`, 'working');
  const response = await sdk.createClient({ baseUrl: pending.baseUrl }).loginRequest({
    type: 'm.login.token',
    token: loginToken,
    initial_device_display_name: 'NEAL web GC',
  });
  const session: MatrixSession = {
    baseUrl: pending.baseUrl,
    accessToken: response.access_token,
    userId: response.user_id,
    deviceId: response.device_id,
  };
  saveSession(session);
  await connectSession(ui, session);
  return true;
};

export const mountMatrixGc = (): void => {
  const root = required<HTMLElement>(document, '#matrix-client');
  activityDock = {
    root: required(document, '#gc-dock'),
    state: required(document, '#gc-dock-state'),
    list: required(document, '#gc-dock-activity'),
  };
  const ui: ClientUi = {
    root,
    entryTabs: required(root, '#matrix-entry-tabs'),
    loginTab: required(root, '#matrix-tab-login'),
    createTab: required(root, '#matrix-tab-create'),
    loginForm: required(root, '#matrix-login-form'),
    userInput: required(root, '#matrix-user-id'),
    passwordInput: required(root, '#matrix-password'),
    loginButton: required(root, '#matrix-login'),
    loginToggle: required(root, '#gc-login-toggle'),
    createToggle: required(root, '#gc-create-toggle'),
    ssoLoginButton: required(root, '#matrix-sso-login'),
    createForm: required(root, '#matrix-create-form'),
    createUsernameInput: required(root, '#matrix-create-username'),
    createIdOutput: required(root, '#matrix-create-id'),
    createTokenInput: required(root, '#matrix-create-token'),
    createPasswordInput: required(root, '#matrix-create-password'),
    createConfirmInput: required(root, '#matrix-create-confirm'),
    createButton: required(root, '#matrix-create'),
    logoutButton: required(root, '#matrix-logout'),
    status: required(root, '#matrix-status'),
    account: required(root, '#matrix-account'),
    memberState: required(root, '#matrix-membership'),
    sessionPanel: required(root, '#matrix-session'),
    knockButton: required(root, '#matrix-knock'),
    joinButton: required(root, '#matrix-join'),
    publicMessages: required(root, '#matrix-public-messages'),
    messages: required(root, '#matrix-messages'),
    composer: required(root, '#matrix-composer'),
    messageInput: required(root, '#matrix-message'),
    sendButton: required(root, '#matrix-send'),
    moderation: required(root, '#matrix-moderation'),
    knockList: required(root, '#matrix-knocks'),
  };

  ui.loginTab.addEventListener('click', () => showEntryMode(ui, 'login'));
  ui.createTab.addEventListener('click', () => showEntryMode(ui, 'create'));
  const updateCreateId = (): void => {
    const username = ui.createUsernameInput.value.trim() || 'your_matrix_name';
    ui.createIdOutput.value = `@${username}:${NEAL_HOMESERVER_DOMAIN}`;
  };
  ui.createUsernameInput.addEventListener('input', updateCreateId);
  ui.userInput.addEventListener('focus', () => {
    void loadSdk().catch((error: unknown) => setStatus(ui, errorMessage(error), 'bad'));
  }, { once: true });
  updateCreateId();

  ui.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.loginButton.disabled = true;
    let password = ui.passwordInput.value;
    try {
      const sdk = await loadSdk();
      const { userId, domain } = parseMatrixId(ui.userInput.value);
      setStatus(ui, `Discovering ${domain}…`, 'working');
      const baseUrl = await discoverHomeserver(sdk, domain);
      const loginClient = sdk.createClient({ baseUrl });
      const flows = await loginClient.loginFlows();
      if (!flows.flows.some((flow) => flow.type === 'm.login.password')) {
        throw new Error('That homeserver does not offer password login. Use the homeserver sign-in button instead.');
      }
      setStatus(ui, `Signing in directly with ${domain}…`, 'working');
      const response = await loginClient.loginRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: userId },
        password,
        initial_device_display_name: 'NEAL web GC',
      });
      password = '';
      ui.passwordInput.value = '';
      const session: MatrixSession = {
        baseUrl,
        accessToken: response.access_token,
        userId: response.user_id,
        deviceId: response.device_id,
      };
      saveSession(session);
      await connectSession(ui, session);
    } catch (error) {
      setStatus(ui, errorMessage(error), 'bad');
    } finally {
      password = '';
      ui.passwordInput.value = '';
      ui.loginButton.disabled = false;
    }
  });

  ui.ssoLoginButton.addEventListener('click', async () => {
    ui.ssoLoginButton.disabled = true;
    try {
      const { domain } = parseMatrixId(ui.userInput.value);
      await beginSso(ui, domain, 'login');
    } catch (error) {
      setStatus(ui, errorMessage(error), 'bad');
      ui.ssoLoginButton.disabled = false;
    }
  });

  ui.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.createButton.disabled = true;
    let password = '';
    let confirmation = '';
    let token = '';
    let verificationWindow: Window | null = null;
    try {
      const username = ui.createUsernameInput.value.trim();
      password = ui.createPasswordInput.value;
      confirmation = ui.createConfirmInput.value;
      token = ui.createTokenInput.value.trim();
      if (!/^[a-z0-9._=\/-]+$/.test(username)) {
        throw new Error('Use a lowercase Matrix username with no spaces.');
      }
      if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
      if (password !== confirmation) throw new Error('The two passwords do not match.');
      verificationWindow = window.open('about:blank', 'neal-matrix-registration', 'popup,width=520,height=720');
      const sdk = await loadSdk();
      setStatus(ui, `Checking account creation with ${NEAL_HOMESERVER_DOMAIN}…`, 'working');
      const baseUrl = await discoverHomeserver(sdk, NEAL_HOMESERVER_DOMAIN);
      await completeNativeRegistration(ui, baseUrl, username, password, token, verificationWindow);
      ui.createTokenInput.value = '';
    } catch (error) {
      verificationWindow?.close();
      setStatus(ui, errorMessage(error), 'bad');
    } finally {
      password = '';
      confirmation = '';
      token = '';
      ui.createPasswordInput.value = '';
      ui.createConfirmInput.value = '';
      ui.createButton.disabled = false;
    }
  });

  ui.knockButton.addEventListener('click', async () => {
    if (!activeClient) return;
    ui.knockButton.disabled = true;
    setStatus(ui, 'Knocking on the NEAL GC…', 'working');
    try {
      await activeClient.knockRoom(ROOM_ID, {
        reason: 'Requesting entry through the NEAL web client.',
        viaServers: ROOM_VIA_SERVERS,
      });
      setStatus(ui, 'Knock sent. A room moderator must admit you.', 'good');
      ui.memberState.textContent = 'KNOCK';
      ui.knockButton.hidden = true;
    } catch (error) {
      setStatus(ui, errorMessage(error), 'bad');
      ui.knockButton.disabled = false;
    }
  });

  ui.joinButton.addEventListener('click', async () => {
    if (!activeClient) return;
    ui.joinButton.disabled = true;
    setStatus(ui, 'Entering the room…', 'working');
    try {
      await activeClient.joinRoom(ROOM_ID, { viaServers: ROOM_VIA_SERVERS });
      const sdk = await loadSdk();
      await renderRoom(ui, activeClient, sdk);
    } catch (error) {
      setStatus(ui, errorMessage(error), 'bad');
      ui.joinButton.disabled = false;
    }
  });

  ui.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeClient) return;
    const body = ui.messageInput.value.trim();
    if (!body) return;
    ui.sendButton.disabled = true;
    try {
      await activeClient.sendTextMessage(ROOM_ID, body);
      ui.messageInput.value = '';
      setStatus(ui, 'Message sent.', 'good');
    } catch (error) {
      setStatus(ui, errorMessage(error), 'bad');
    } finally {
      ui.sendButton.disabled = false;
    }
  });

  ui.logoutButton.addEventListener('click', async () => {
    const client = activeClient;
    activeClient = null;
    sessionStorage.removeItem(SESSION_KEY);
    ui.logoutButton.disabled = true;
    setStatus(ui, 'Closing this Matrix device session…', 'working');
    try {
      if (client) await client.logout(true);
      setStatus(ui, 'Signed out. This tab no longer holds an access token.', 'good');
    } catch (error) {
      client?.stopClient();
      setStatus(ui, `Local session cleared. Homeserver logout failed: ${errorMessage(error)}`, 'bad');
    } finally {
      ui.entryTabs.hidden = false;
      showEntryMode(ui, 'login');
      ui.loginForm.hidden = false;
      ui.loginToggle.hidden = false;
      ui.loginToggle.setAttribute('aria-expanded', 'false');
      ui.createToggle.hidden = false;
      ui.createToggle.setAttribute('aria-expanded', 'false');
      ui.root.closest('#gc')?.classList.remove('gc-login-open');
      ui.publicMessages.hidden = false;
      ui.sessionPanel.hidden = true;
      ui.logoutButton.hidden = true;
      ui.logoutButton.disabled = false;
      ui.account.textContent = 'NOT SIGNED IN';
      ui.memberState.textContent = '—';
      clearList(ui.messages);
      startPublicTimeline(ui);
    }
  });

  void (async () => {
    try {
      if (await consumeSsoCallback(ui)) return;
      const session = readSession();
      if (session) await connectSession(ui, session);
      else startPublicTimeline(ui);
    } catch (error) {
      ui.entryTabs.hidden = false;
      showEntryMode(ui, 'login');
      ui.loginToggle.hidden = false;
      ui.loginToggle.setAttribute('aria-expanded', 'false');
      ui.createToggle.hidden = false;
      ui.createToggle.setAttribute('aria-expanded', 'false');
      ui.root.closest('#gc')?.classList.remove('gc-login-open');
      ui.publicMessages.hidden = false;
      startPublicTimeline(ui);
      setStatus(ui, errorMessage(error), 'bad');
    }
  })();
};
