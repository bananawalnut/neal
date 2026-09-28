import { Buffer } from 'buffer/';

Object.assign(globalThis, { Buffer });

await import('./admin');
