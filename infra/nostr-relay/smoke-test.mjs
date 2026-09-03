#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { schnorr } from "@noble/curves/secp256k1.js";
import WebSocket from "ws";

const relayUrl = process.env.NEAL_NOSTR_RELAY ?? "ws://127.0.0.1:7777";
const receiptPath = process.argv[2];

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const eventId = (event) =>
  createHash("sha256")
    .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
    .digest("hex");

const openSocket = () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`timed out opening ${relayUrl}`));
    }, 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", reject);
  });

const receiveUntil = (socket, predicate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for relay response"));
    }, 5000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });

const fetchById = async (id) => {
  const socket = await openSocket();
  const subscription = `neal-smoke-${Date.now()}`;
  const response = receiveUntil(
    socket,
    (message) => message[0] === "EVENT" && message[1] === subscription && message[2]?.id === id,
  );
  socket.send(JSON.stringify(["REQ", subscription, { ids: [id], limit: 1 }]));
  const message = await response;
  socket.send(JSON.stringify(["CLOSE", subscription]));
  socket.close();
  return message[2];
};

if (receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const fetched = await fetchById(receipt.id);
  if (JSON.stringify(fetched) !== JSON.stringify(receipt.event)) {
    throw new Error("persisted event does not match the smoke-test receipt");
  }
  console.log(JSON.stringify({ relayUrl, persisted: true, id: receipt.id }));
  process.exit(0);
}

const privateKey = randomBytes(32);
const unsigned = {
  pubkey: hex(schnorr.getPublicKey(privateKey)),
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [["t", "neal-relay-smoke-test"]],
  content: `NEAL relay smoke test ${new Date().toISOString()}`,
};
const id = eventId(unsigned);
const event = { ...unsigned, id, sig: hex(schnorr.sign(id, privateKey)) };

const socket = await openSocket();
const accepted = receiveUntil(socket, (message) => message[0] === "OK" && message[1] === id);
socket.send(JSON.stringify(["EVENT", event]));
const ok = await accepted;
socket.close();
if (ok[2] !== true) throw new Error(`relay rejected event: ${ok[3] ?? "unknown reason"}`);

const fetched = await fetchById(id);
if (JSON.stringify(fetched) !== JSON.stringify(event)) {
  throw new Error("published event did not round-trip exactly");
}

console.log(JSON.stringify({ relayUrl, accepted: true, fetched: true, id, event }));
