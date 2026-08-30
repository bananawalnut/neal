const STORAGE_KEY = 'neal.local-yahoos/v1';
const CHANGE_EVENT = 'neal:local-yahoo-change';
const RATE_WINDOW_MS = 60_000;
const MAX_STORED_EVENTS = 10_000;

type StoredYahooState = {
  schema: 'neal.local-yahoos/v1';
  events: number[];
};

export type LocalYahooStats = {
  total: number;
  fastestThreeMs: number | null;
  peakPerMinute: number;
  lastAt: number | null;
};

function emptyState(): StoredYahooState {
  return { schema: 'neal.local-yahoos/v1', events: [] };
}

let memoryState = emptyState();

function readState(): StoredYahooState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryState;
    const candidate = JSON.parse(raw) as Partial<StoredYahooState>;
    if (candidate.schema !== 'neal.local-yahoos/v1' || !Array.isArray(candidate.events)) return emptyState();
    const events = candidate.events
      .filter((value): value is number => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right)
      .slice(-MAX_STORED_EVENTS);
    memoryState = { schema: 'neal.local-yahoos/v1', events };
    return memoryState;
  } catch {
    return memoryState;
  }
}

function writeState(state: StoredYahooState) {
  memoryState = state;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private or locked-down browsers still get a working in-memory session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getLocalYahooStats(): LocalYahooStats {
  const events = readState().events;
  let fastestThreeMs: number | null = null;
  for (let index = 0; index + 2 < events.length; index += 1) {
    const elapsed = events[index + 2] - events[index];
    fastestThreeMs = fastestThreeMs === null ? elapsed : Math.min(fastestThreeMs, elapsed);
  }

  let peakPerMinute = 0;
  let windowStart = 0;
  for (let windowEnd = 0; windowEnd < events.length; windowEnd += 1) {
    while (events[windowEnd] - events[windowStart] > RATE_WINDOW_MS) windowStart += 1;
    peakPerMinute = Math.max(peakPerMinute, windowEnd - windowStart + 1);
  }

  return {
    total: events.length,
    fastestThreeMs,
    peakPerMinute,
    lastAt: events.at(-1) ?? null,
  };
}

export function recordLocalYahoo(): LocalYahooStats {
  const state = readState();
  state.events.push(Date.now());
  state.events = state.events.slice(-MAX_STORED_EVENTS);
  writeState(state);
  return getLocalYahooStats();
}

export function onLocalYahooChange(listener: (stats: LocalYahooStats) => void): () => void {
  const notify = () => listener(getLocalYahooStats());
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener('storage', notify);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener('storage', notify);
  };
}

export function formatLocalStreak(elapsedMs: number | null): string {
  if (elapsedMs === null) return '—';
  if (elapsedMs < 1_000) return `${elapsedMs} MS`;
  return `${(elapsedMs / 1_000).toFixed(2)} SEC`;
}
