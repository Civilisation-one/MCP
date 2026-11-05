import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { signBridgeMessage } from "../src/bridge/protocol.js";
import {
  decodeLiGiPacket,
  encodeLiGiPacket,
  receiveViaLiGi,
  sendViaLiGi,
  type LiGiPacket,
  type LiGiTransportPort,
} from "../src/transport/ligi-adapter.js";

const sessionId = "0123456789abcdef";
function message() {
  return signBridgeMessage({
    protocol: "NUN-VIREAX",
    version: "1.0.0",
    messageId: randomUUID(),
    correlationId: randomUUID(),
    sequence: 1,
    sender: { nodeId: "nun-optical-01", system: "NuN", version: "0.1.0", keyId: "nun-key-01" },
    timestamp: new Date().toISOString(),
    messageType: "STATE_PROPOSAL",
    payload: { state: [0.2, 0.8] },
  }, (awaitlessKey()).privateKey);
}
import { generateKeyPairSync } from "node:crypto";
const keys = generateKeyPairSync("ed25519");
function awaitlessKey() { return keys; }

test("packet preserves the original signed envelope and session binding", () => {
  const original = message();
  const packet = encodeLiGiPacket(original, sessionId);
  const decoded = decodeLiGiPacket(packet);
  assert.equal(decoded.sessionId, sessionId);
  assert.deepEqual(decoded.message, original);
});

test("packet tampering is rejected before Centre Node ingress", () => {
  const packet = encodeLiGiPacket(message(), sessionId);
  const tampered = { ...packet, messageJson: packet.messageJson.replace('"state":[0.2,0.8]', '"state":[9,9]') };
  assert.throws(() => decodeLiGiPacket(tampered), /LIGI_PACKET_HASH_MISMATCH/);
});

test("transport ACK is bound to session, message and exact packet hash", async () => {
  const original = message();
  const port: LiGiTransportPort = {
    async transmit(packet) {
      return {
        kind: "TRANSPORT_RECEIVED",
        sessionId: packet.sessionId,
        messageId: packet.messageId,
        messageHash: packet.messageHash,
        receivedAt: new Date().toISOString(),
      };
    },
    async receive() { throw new Error("unused"); },
  };
  const ack = await sendViaLiGi(port, original, sessionId);
  assert.equal(ack.kind, "TRANSPORT_RECEIVED");
  assert.equal(ack.messageId, original.messageId);
});

test("mismatched ACK cannot be mistaken for a successful transport receipt", async () => {
  const port: LiGiTransportPort = {
    async transmit(packet) {
      return {
        kind: "TRANSPORT_RECEIVED",
        sessionId: packet.sessionId,
        messageId: randomUUID(),
        messageHash: packet.messageHash,
        receivedAt: new Date().toISOString(),
      };
    },
    async receive() { throw new Error("unused"); },
  };
  await assert.rejects(() => sendViaLiGi(port, message(), sessionId), /LIGI_ACK_BINDING_INVALID/);
});

test("receive returns a decoded message but does not claim it is authenticated", async () => {
  const packet: LiGiPacket = encodeLiGiPacket(message(), sessionId);
  const port: LiGiTransportPort = {
    async transmit() { throw new Error("unused"); },
    async receive() { return packet; },
  };
  const received = await receiveViaLiGi(port);
  assert.equal(received.message.sender.system, "NuN");
  assert.equal(received.sessionId, sessionId);
});

test("oversized packets are rejected", () => {
  assert.throws(() => encodeLiGiPacket(message(), sessionId, 1024), /LIGI_PACKET_TOO_LARGE/);
});
