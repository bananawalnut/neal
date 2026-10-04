import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createServer } from 'vite';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const recentBlockhash = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();

let vite;
let validatePhantomSignedTransaction;
let createInjectedPhantomWallet;

before(async () => {
  const browserWindow = new EventTarget();
  browserWindow.location = { hostname: 'neal.invalid', port: '', protocol: 'https:' };
  globalThis.window = browserWindow;
  globalThis.location = browserWindow.location;
  vite = await createServer({
    root: repository,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  ({ validatePhantomSignedTransaction } = await vite.ssrLoadModule('/apps/site/src/phantom-transaction.ts'));
  ({ createInjectedPhantomWallet } = await vite.ssrLoadModule('/apps/site/src/wallet.ts'));
});

after(async () => {
  await vite?.close();
});

const transaction = (lamports) => new VersionedTransaction(new TransactionMessage({
  payerKey: signer.publicKey,
  recentBlockhash,
  instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient, lamports })],
}).compileToV0Message());

const phantomPublicKey = (keypair = signer) => ({
  toBase58: () => keypair.publicKey.toBase58(),
  toBytes: () => keypair.publicKey.toBytes(),
});

const provider = (overrides = {}) => ({
  isPhantom: true,
  isConnected: false,
  publicKey: null,
  on() {},
  async connect() { return { publicKey: phantomPublicKey() }; },
  async disconnect() {},
  async signMessage() { return { signature: new Uint8Array(64) }; },
  async signTransaction(value) { value.sign([signer]); return value; },
  ...overrides,
});

const connect = async (wallet) => {
  await wallet.features['standard:connect'].connect();
  assert.equal(wallet.accounts.length, 1);
  return wallet.accounts[0];
};

test('Phantom compatibility accepts the selected account validly signing an unchanged message', async () => {
  const unsigned = transaction(1);
  const expectedMessage = new Uint8Array(unsigned.message.serialize());
  const signed = VersionedTransaction.deserialize(unsigned.serialize());
  signed.sign([signer]);

  const validated = await validatePhantomSignedTransaction(
    expectedMessage,
    new Uint8Array(signed.serialize()),
    signer.publicKey.toBytes(),
  );

  assert.deepEqual(
    VersionedTransaction.deserialize(validated).message.serialize(),
    unsigned.message.serialize(),
  );
});

test('Phantom compatibility rejects a provider that mutates transaction intent before signing', async () => {
  const expected = transaction(1);
  const mutated = transaction(2);
  mutated.sign([signer]);

  await assert.rejects(
    validatePhantomSignedTransaction(
      new Uint8Array(expected.message.serialize()),
      new Uint8Array(mutated.serialize()),
      signer.publicKey.toBytes(),
    ),
    /changed the transaction intent/u,
  );
});

test('Phantom compatibility rejects an unchanged message without a valid selected-account signature', async () => {
  const unsigned = transaction(1);
  await assert.rejects(
    validatePhantomSignedTransaction(
      new Uint8Array(unsigned.message.serialize()),
      new Uint8Array(unsigned.serialize()),
      signer.publicKey.toBytes(),
    ),
    /invalid transaction signature/u,
  );
});

test('Phantom compatibility rejects a selected account that is not a required signer', async () => {
  const signed = transaction(1);
  signed.sign([signer]);
  await assert.rejects(
    validatePhantomSignedTransaction(
      new Uint8Array(signed.message.serialize()),
      new Uint8Array(signed.serialize()),
      recipient.toBytes(),
    ),
    /not a required transaction signer/u,
  );
});

test('injected Phantom wrapper validates the signed transaction before returning it', async () => {
  const wallet = createInjectedPhantomWallet(provider());
  const account = await connect(wallet);
  const unsigned = transaction(1);
  const [output] = await wallet.features['solana:signTransaction'].signTransaction({
    account,
    chain: 'solana:devnet',
    transaction: new Uint8Array(unsigned.serialize()),
  });
  assert.deepEqual(
    VersionedTransaction.deserialize(output.signedTransaction).message.serialize(),
    unsigned.message.serialize(),
  );
});

test('injected Phantom wrapper rejects transaction substitution by the provider', async () => {
  const wallet = createInjectedPhantomWallet(provider({
    async signTransaction() {
      const substituted = transaction(2);
      substituted.sign([signer]);
      return substituted;
    },
  }));
  const account = await connect(wallet);
  const unsigned = transaction(1);
  await assert.rejects(
    wallet.features['solana:signTransaction'].signTransaction({
      account,
      chain: 'solana:devnet',
      transaction: new Uint8Array(unsigned.serialize()),
    }),
    /changed the transaction intent/u,
  );
});

test('injected Phantom wrapper fails closed before provider signing on an unsupported chain', async () => {
  let signingCalls = 0;
  const wallet = createInjectedPhantomWallet(provider({
    async signTransaction(value) { signingCalls += 1; value.sign([signer]); return value; },
  }));
  const account = await connect(wallet);
  await assert.rejects(
    wallet.features['solana:signTransaction'].signTransaction({
      account,
      chain: 'solana:malicious',
      transaction: new Uint8Array(transaction(1).serialize()),
    }),
    /unsupported Solana chain/u,
  );
  assert.equal(signingCalls, 0);
});

test('injected Phantom wrapper rejects inconsistent public-key encodings', async () => {
  const wallet = createInjectedPhantomWallet(provider({
    async connect() {
      return {
        publicKey: {
          toBase58: () => recipient.toBase58(),
          toBytes: () => signer.publicKey.toBytes(),
        },
      };
    },
  }));
  await assert.rejects(wallet.features['standard:connect'].connect(), /inconsistent Solana public key/u);
});
