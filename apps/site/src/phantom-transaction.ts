import { PublicKey, VersionedTransaction } from '@solana/web3.js';

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const requiredSignerKeys = (transaction: VersionedTransaction): readonly PublicKey[] => {
  const { message } = transaction;
  return message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
};

/**
 * Normalize and validate a transaction returned by Phantom's legacy injected
 * provider before exposing it through the Wallet Standard compatibility layer.
 */
export const validatePhantomSignedTransaction = async (
  expectedMessage: Uint8Array,
  signedWire: Uint8Array,
  selectedAccountPublicKey: Uint8Array,
): Promise<Uint8Array> => {
  const normalizedWire = new Uint8Array(signedWire);
  const normalized = VersionedTransaction.deserialize(normalizedWire);
  const actualMessage = new Uint8Array(normalized.message.serialize());
  if (!equalBytes(new Uint8Array(expectedMessage), actualMessage)) {
    throw new Error('Phantom changed the transaction intent; signature rejected');
  }

  const selectedKey = new PublicKey(new Uint8Array(selectedAccountPublicKey));
  const signerIndex = requiredSignerKeys(normalized).findIndex((key) => key.equals(selectedKey));
  if (signerIndex < 0) throw new Error('The selected Phantom account is not a required transaction signer');

  const signature = normalized.signatures[signerIndex];
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error('Phantom returned an invalid transaction signature');
  }
  const verificationKey = await globalThis.crypto.subtle.importKey(
    'raw',
    new Uint8Array(selectedKey.toBytes()),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const verified = await globalThis.crypto.subtle.verify(
    { name: 'Ed25519' },
    verificationKey,
    new Uint8Array(signature),
    actualMessage,
  );
  if (!verified) throw new Error('Phantom returned an invalid transaction signature');
  return normalizedWire;
};
