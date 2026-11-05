import { createHash } from "node:crypto";
import { z } from "zod";
import {
  bridgeMessageSchema,
  canonicalJson,
  type BridgeMessage,
} from "../bridge/protocol.js";

/**
 * Transport wrapper only. The embedded NUN-VIREAX envelope remains the
 * end-to-end signed authority-bearing message and MUST be verified by the
 * VIREÁX Centre Node after reception.
 */
export const LIGI_PACKET_PROTOCOL = "VIREAX-LIGI" as const;
export const LIGI_PACKET_VERSION = "1.0.0" as const;
export const MAX_LIGI_PACKET_BYTES = 4 * 1024 * 1024;

const packetSchema = z.object({
  protocol: z.literal(LIGI_PACKET_PROTOCOL),
  version: z.literal(LIGI_PACKET_VERSION),
  sessionId: z.string().regex(/^[a-f0-9]{16,128}$/i),
  messageId: z.string().uuid(),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/),
  messageJson: z.string().min(2).max(MAX_LIGI_PACKET_BYTES),
}).strict();

export type LiGiPacket = z.infer<typeof packetSchema>;

export interface LiGiTransportAck {
  sessionId: string;
  messageId: string;
  messageHash: string;
  receivedAt: string;
  /** Always transport-only. This is not a state-commit or authority receipt. */
  kind: "TRANSPORT_RECEIVED";
}

export interface LiGiTransportPort {
  /**
   * Implement using the installed LiGi optical workflow. Implementations must
   * honour AbortSignal and resolve only after a complete payload is recovered.
   */
  transmit(packet: LiGiPacket, signal: AbortSignal): Promise<LiGiTransportAck>;
  receive(signal: AbortSignal): Promise<LiGiPacket>;
}

export interface LiGiAdapterOptions {
  timeoutMs?: number;
  maxPacketBytes?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("LIGI_INVALID_TIMEOUT");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("LIGI_TRANSPORT_TIMEOUT"));
    }, timeoutMs);
  });
  return Promise.race([operation(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    controller.abort();
  });
}

export function encodeLiGiPacket(
  messageInput: unknown,
  sessionId: string,
  maxPacketBytes = MAX_LIGI_PACKET_BYTES,
): LiGiPacket {
  const message = bridgeMessageSchema.parse(messageInput) as BridgeMessage;
  if (!/^[a-f0-9]{16,128}$/i.test(sessionId)) throw new Error("LIGI_INVALID_SESSION_ID");
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 1024 || maxPacketBytes > MAX_LIGI_PACKET_BYTES) {
    throw new Error("LIGI_INVALID_PACKET_LIMIT");
  }
  const messageJson = canonicalJson(message);
  if (Buffer.byteLength(messageJson, "utf8") > maxPacketBytes) throw new Error("LIGI_PACKET_TOO_LARGE");
  return {
    protocol: LIGI_PACKET_PROTOCOL,
    version: LIGI_PACKET_VERSION,
    sessionId,
    messageId: message.messageId,
    messageHash: sha256(messageJson),
    messageJson,
  };
}

export function decodeLiGiPacket(
  packetInput: unknown,
  maxPacketBytes = MAX_LIGI_PACKET_BYTES,
): { sessionId: string; message: BridgeMessage } {
  const packet = packetSchema.parse(packetInput);
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 1024 || maxPacketBytes > MAX_LIGI_PACKET_BYTES) {
    throw new Error("LIGI_INVALID_PACKET_LIMIT");
  }
  if (Buffer.byteLength(packet.messageJson, "utf8") > maxPacketBytes) throw new Error("LIGI_PACKET_TOO_LARGE");
  if (sha256(packet.messageJson) !== packet.messageHash) throw new Error("LIGI_PACKET_HASH_MISMATCH");

  let parsed: unknown;
  try {
    parsed = JSON.parse(packet.messageJson);
  } catch {
    throw new Error("LIGI_PACKET_INVALID_JSON");
  }
  const message = bridgeMessageSchema.parse(parsed) as BridgeMessage;
  if (message.messageId !== packet.messageId) throw new Error("LIGI_PACKET_MESSAGE_ID_MISMATCH");
  return { sessionId: packet.sessionId, message };
}

/**
 * Sends one signed envelope over a LiGi transport implementation. A returned
 * ACK confirms only transport receipt of the exact packet, never authorisation,
 * execution, or a committed NuN state transition.
 */
export async function sendViaLiGi(
  port: LiGiTransportPort,
  message: unknown,
  sessionId: string,
  options: LiGiAdapterOptions = {},
): Promise<LiGiTransportAck> {
  const packet = encodeLiGiPacket(message, sessionId, options.maxPacketBytes);
  const ack = await withTimeout(
    (signal) => port.transmit(packet, signal),
    options.timeoutMs ?? 30_000,
  );
  if (
    ack.kind !== "TRANSPORT_RECEIVED" ||
    ack.sessionId !== packet.sessionId ||
    ack.messageId !== packet.messageId ||
    ack.messageHash !== packet.messageHash ||
    !Number.isFinite(Date.parse(ack.receivedAt))
  ) {
    throw new Error("LIGI_ACK_BINDING_INVALID");
  }
  return ack;
}

/**
 * Receives a fully reconstructed LiGi packet. The caller MUST pass the
 * returned message to VireaxCentreNode.ingest; decoding is not authentication.
 */
export async function receiveViaLiGi(
  port: LiGiTransportPort,
  options: LiGiAdapterOptions = {},
): Promise<{ sessionId: string; message: BridgeMessage }> {
  const packet = await withTimeout(
    (signal) => port.receive(signal),
    options.timeoutMs ?? 30_000,
  );
  return decodeLiGiPacket(packet, options.maxPacketBytes);
}
