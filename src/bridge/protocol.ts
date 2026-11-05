import { createHash, sign, verify, type KeyLike } from "node:crypto";
import { z } from "zod";

export const BRIDGE_PROTOCOL = "NUN-VIREAX" as const;
export const BRIDGE_VERSION = "1.0.0" as const;
export const MESSAGE_TYPES = ["HELLO", "CAPABILITIES", "STATE_PROPOSAL", "STATE_RESPONSE", "VERIFICATION_RECEIPT", "OBJECTION", "ACK"] as const;
export type BridgeMessageType = (typeof MESSAGE_TYPES)[number];
export type BridgeSystem = "NuN" | "VIREAX";

const identitySchema = z.object({
  nodeId: z.string().min(1).max(128),
  system: z.enum(["NuN", "VIREAX"]),
  version: z.string().min(1).max(64),
  keyId: z.string().min(1).max(128),
}).strict();

export const bridgeMessageSchema = z.object({
  protocol: z.literal(BRIDGE_PROTOCOL),
  version: z.literal(BRIDGE_VERSION),
  messageId: z.string().uuid(),
  correlationId: z.string().uuid(),
  sequence: z.number().int().nonnegative().safe(),
  sender: identitySchema,
  timestamp: z.string().datetime({ offset: true }),
  messageType: z.enum(MESSAGE_TYPES),
  payload: z.unknown(),
  provenance: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  signature: z.string().min(1).max(2048),
}).strict();

export type BridgeMessage<T = unknown> = z.infer<typeof bridgeMessageSchema> & { payload: T };
export type UnsignedBridgeMessage<T = unknown> = Omit<BridgeMessage<T>, "signature" | "provenance"> & {
  provenance: { contentHash: string; previousHash?: string };
};

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stable(object[key])).join(",") + "}";
}
export function canonicalJson(value: unknown): string { return stable(value); }
export function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function signingBody(message: Omit<BridgeMessage, "signature">): string {
  return canonicalJson(message);
}

/** Sign with an Ed25519 private key. The content hash binds the canonical payload, not just its metadata. */
export function signBridgeMessage<T>(
  input: Omit<UnsignedBridgeMessage<T>, "provenance"> & { previousHash?: string },
  privateKey: KeyLike,
): BridgeMessage<T> {
  const contentHash = sha256(canonicalJson(input.payload));
  const { previousHash, ...base } = input;
  const unsigned = {
    ...base,
    provenance: { contentHash, ...(previousHash ? { previousHash } : {}) },
  } as Omit<BridgeMessage<T>, "signature">;
  const signature = sign(null, Buffer.from(signingBody(unsigned as Omit<BridgeMessage, "signature">)), privateKey).toString("base64");
  return { ...unsigned, signature };
}

/** Verify schema, payload hash and Ed25519 signature against a previously trusted public key. */
export function verifyBridgeMessage(input: unknown, publicKey: KeyLike): BridgeMessage {
  const parsed = bridgeMessageSchema.parse(input);
  if (sha256(canonicalJson(parsed.payload)) !== parsed.provenance.contentHash) {
    throw new Error("BRIDGE_CONTENT_HASH_MISMATCH");
  }
  const { signature, ...unsigned } = parsed;
  const ok = verify(null, Buffer.from(signingBody(unsigned)), publicKey, Buffer.from(signature, "base64"));
  if (!ok) throw new Error("BRIDGE_SIGNATURE_INVALID");
  return parsed;
}

export class SequenceGuard {
  private readonly last = new Map<string, number>();
  accept(nodeId: string, sequence: number): void {
    const previous = this.last.get(nodeId);
    if (previous !== undefined && sequence <= previous) throw new Error("BRIDGE_REPLAY_OR_STALE_SEQUENCE");
    this.last.set(nodeId, sequence);
  }
  snapshot(): Record<string, number> { return Object.fromEntries(this.last); }
  restore(state: Record<string, number>): void {
    for (const [nodeId, sequence] of Object.entries(state)) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("BRIDGE_INVALID_SEQUENCE_SNAPSHOT");
      this.last.set(nodeId, sequence);
    }
  }
}
