import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { signBridgeMessage } from "../src/bridge/protocol.js";
import {
  MemoryAuditLedger,
  TrustedIdentityRegistry,
  VireaxCentreNode,
  type CentrePipeline,
  type StageContext,
} from "../src/centre-node/control-plane.js";

function makeMessage(privateKey: KeyObject, sequence = 1, nodeId = "nun-compute-01") {
  return signBridgeMessage({
    protocol: "NUN-VIREAX",
    version: "1.0.0",
    messageId: randomUUID(),
    correlationId: randomUUID(),
    sequence,
    sender: { nodeId, system: "NuN", version: "0.1.0", keyId: "nun-key-01" },
    timestamp: new Date().toISOString(),
    messageType: "STATE_PROPOSAL",
    payload: { logicalStep: sequence, state: [0.25, 0.75] },
  }, privateKey);
}

function pipeline(order: string[], decision: "ACCEPT" | "REJECT" | "QUARANTINE" | "REQUEST_EVIDENCE" | "PROPOSE_ACTION" = "ACCEPT"): CentrePipeline {
  const stage = (name: string, final = false) => async (context: StageContext) => {
    order.push(name);
    return {
      output: { stage: name, priorStages: Object.keys(context.prior) },
      ...(final ? { decision } : {}),
      evidenceRefs: final ? ["evidence:local-check-1"] : [],
      objections: [],
    };
  };
  return {
    mirror: stage("MIRROR"),
    critic: stage("CRITIC"),
    evidence: stage("EVIDENCE"),
    synthesis: stage("SYNTHESIS", true),
  };
}

function setup(decision?: "ACCEPT" | "REJECT" | "QUARANTINE" | "REQUEST_EVIDENCE" | "PROPOSE_ACTION") {
  const keys = generateKeyPairSync("ed25519");
  const identities = new TrustedIdentityRegistry();
  identities.register({
    system: "NuN",
    nodeId: "nun-compute-01",
    keyId: "nun-key-01",
    version: "0.1.0",
    publicKey: keys.publicKey,
  });
  const order: string[] = [];
  const audit = new MemoryAuditLedger();
  const node = new VireaxCentreNode(identities, pipeline(order, decision), audit);
  return { keys, node, order, audit };
}

test("Centre Node authenticates NuN and runs the four stages in order", async () => {
  const { keys, node, order, audit } = setup();
  const result = await node.ingest(makeMessage(keys.privateKey));
  assert.deepEqual(order, ["MIRROR", "CRITIC", "EVIDENCE", "SYNTHESIS"]);
  assert.equal(result.outcome, "ACCEPTED_FOR_REVIEW");
  assert.equal(result.trust, "SIGNATURE_AND_IDENTITY_VERIFIED");
  assert.deepEqual(result.stageOrder, ["MIRROR", "CRITIC", "EVIDENCE", "SYNTHESIS"]);
  assert.equal(audit.list().at(-1)?.type, "ORCHESTRATION_DECISION");
});

test("unknown identity is rejected before pipeline execution", async () => {
  const { keys, node, order } = setup();
  const message = makeMessage(keys.privateKey, 1, "nun-unknown-99");
  await assert.rejects(() => node.ingest(message), /CENTRE_IDENTITY_NOT_TRUSTED/);
  assert.deepEqual(order, []);
});

test("tampered signed payload is rejected", async () => {
  const { keys, node, order } = setup();
  const message = makeMessage(keys.privateKey);
  message.payload = { logicalStep: 1, state: [99, 99] };
  await assert.rejects(() => node.ingest(message), /CENTRE_CONTENT_HASH|CENTRE_IDENTITY|BRIDGE_CONTENT_HASH_MISMATCH/);
  assert.deepEqual(order, []);
});

test("replayed sequence is rejected", async () => {
  const { keys, node } = setup();
  const first = makeMessage(keys.privateKey, 4);
  await node.ingest(first);
  await assert.rejects(() => node.ingest(first), /BRIDGE_REPLAY_OR_STALE_SEQUENCE/);
});

test("proposed action is never executed or authorised by synthesis", async () => {
  const { keys, node, audit } = setup("PROPOSE_ACTION");
  const result = await node.ingest(makeMessage(keys.privateKey));
  assert.equal(result.outcome, "ACTION_REQUIRES_SEPARATE_AUTHORIZATION");
  const finalEvent = audit.list().at(-1);
  assert.equal(finalEvent?.details.actionExecuted, false);
  assert.equal(finalEvent?.details.authorizationGranted, false);
});
