import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { signBridgeMessage, verifyBridgeMessage, SequenceGuard } from "../src/bridge/protocol.js";
import { validateNuNTemporalState } from "../src/bridge/state-validator.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const hash = "a".repeat(64);
function message(sequence = 1) {
  return signBridgeMessage({
    protocol: "NUN-VIREAX", version: "1.0.0",
    messageId: "d9428888-122b-4b27-bf1b-9a4b1d4b0f11",
    correlationId: "d9428888-122b-4b27-bf1b-9a4b1d4b0f12",
    sequence, sender: { nodeId: "nun-node-1", system: "NuN", version: "0.1", keyId: "nun-key-1" },
    timestamp: "2026-11-05T02:00:00.000Z", messageType: "STATE_PROPOSAL",
    payload: { state: [1, 2], claim: "unverified" }, previousHash: hash,
  }, privateKey);
}

test("Ed25519-signed bridge message verifies and tampering is rejected", () => {
  const signed = message();
  assert.equal(verifyBridgeMessage(signed, publicKey).messageType, "STATE_PROPOSAL");
  assert.throws(() => verifyBridgeMessage({ ...signed, payload: { state: [9] } }, publicKey), /CONTENT_HASH_MISMATCH/);
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => verifyBridgeMessage(signed, other.publicKey), /SIGNATURE_INVALID/);
});

test("sequence guard rejects replay and restores persisted high-water marks", () => {
  const guard = new SequenceGuard();
  guard.accept("nun-node-1", 4);
  assert.throws(() => guard.accept("nun-node-1", 4), /REPLAY_OR_STALE/);
  assert.throws(() => guard.accept("nun-node-1", 3), /REPLAY_OR_STALE/);
  const restored = new SequenceGuard();
  restored.restore(guard.snapshot());
  assert.throws(() => restored.accept("nun-node-1", 4), /REPLAY_OR_STALE/);
  restored.accept("nun-node-1", 5);
});

test("temporal state checks vector, uncertainty and units dimensions", () => {
  const valid = {
    modelId: "nun-test", modelVersion: "0.1",
    clock: { logicalStep: 1, physicalTimestamp: "2026-11-05T02:00:00.000Z", epoch: "test-epoch" },
    fastState: { values: [0.1, 0.2], dimension: 2 },
    slowState: { values: [0.3], dimension: 1 },
    uncertainty: { representation: "diagonal", values: [1, 1, 1], semantics: "variance" },
    transition: { inputHash: hash, previousStateHash: hash, predictedStateHash: hash },
    metadata: { units: ["m", "m", "s"], coordinateSystem: "declared-test-frame", assumptions: [] },
  };
  assert.equal(validateNuNTemporalState(valid).clock.logicalStep, 1);
  assert.throws(() => validateNuNTemporalState({ ...valid, fastState: { values: [1], dimension: 2 } }), /FAST_DIMENSION_MISMATCH/);
  assert.throws(() => validateNuNTemporalState({ ...valid, uncertainty: { ...valid.uncertainty, values: [1] } }), /UNCERTAINTY_DIMENSION_MISMATCH/);
});
