import { createHash, type KeyLike } from "node:crypto";
import {
  bridgeMessageSchema,
  SequenceGuard,
  verifyBridgeMessage,
  type BridgeMessage,
} from "../bridge/protocol.js";

export interface TrustedNode {
  system: "NuN" | "VIREAX";
  nodeId: string;
  keyId: string;
  version: string;
  publicKey: KeyLike;
}

export class TrustedIdentityRegistry {
  private readonly keys = new Map<string, TrustedNode>();

  register(node: TrustedNode): void {
    const id = this.key(node.system, node.nodeId, node.keyId);
    if (this.keys.has(id)) throw new Error("CENTRE_DUPLICATE_TRUSTED_KEY");
    this.keys.set(id, Object.freeze({ ...node }));
  }

  resolve(system: TrustedNode["system"], nodeId: string, keyId: string): TrustedNode | undefined {
    return this.keys.get(this.key(system, nodeId, keyId));
  }

  private key(system: string, nodeId: string, keyId: string): string {
    return `${system}:${nodeId}:${keyId}`;
  }
}

export type PipelineDecision =
  | "ACCEPT"
  | "REJECT"
  | "QUARANTINE"
  | "REQUEST_EVIDENCE"
  | "PROPOSE_ACTION";

export interface StageResult {
  output: unknown;
  evidenceRefs?: string[];
  objections?: string[];
  decision?: PipelineDecision;
}

export interface StageContext {
  message: BridgeMessage;
  prior: Readonly<Record<string, unknown>>;
}

export interface CentrePipeline {
  mirror(context: StageContext): Promise<StageResult>;
  critic(context: StageContext): Promise<StageResult>;
  evidence(context: StageContext): Promise<StageResult>;
  synthesis(context: StageContext): Promise<StageResult>;
}

export interface AuditEvent {
  sequence: number;
  type: string;
  at: string;
  messageId: string;
  details: Record<string, unknown>;
  previousHash: string | null;
  hash: string;
}

export class MemoryAuditLedger {
  private readonly entries: AuditEvent[] = [];

  append(type: string, messageId: string, details: Record<string, unknown>): AuditEvent {
    const previousHash = this.entries.at(-1)?.hash ?? null;
    const body = {
      sequence: this.entries.length + 1,
      type,
      at: new Date().toISOString(),
      messageId,
      details: structuredClone(details),
      previousHash,
    };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const event = Object.freeze({ ...body, hash });
    this.entries.push(event);
    return structuredClone(event);
  }

  list(): AuditEvent[] {
    return structuredClone(this.entries);
  }
}

export type CentreOutcome =
  | "ACCEPTED_FOR_REVIEW"
  | "REJECTED"
  | "QUARANTINED"
  | "MORE_EVIDENCE_REQUIRED"
  | "ACTION_REQUIRES_SEPARATE_AUTHORIZATION";

export interface CentreResult {
  messageId: string;
  correlationId: string;
  sender: { system: string; nodeId: string; keyId: string };
  outcome: CentreOutcome;
  trust: "SIGNATURE_AND_IDENTITY_VERIFIED";
  stageOrder: ["MIRROR", "CRITIC", "EVIDENCE", "SYNTHESIS"];
  stages: Record<string, StageResult>;
}

/**
 * VIREÁX Centre Node ingress/orchestration core.
 * It verifies registered NuN identities, rejects replayed sequences, and runs
 * the four review stages in order. It does not execute external actions.
 */
export class VireaxCentreNode {
  private readonly sequences = new SequenceGuard();

  constructor(
    private readonly identities: TrustedIdentityRegistry,
    private readonly pipeline: CentrePipeline,
    private readonly audit: MemoryAuditLedger,
  ) {}

  async ingest(input: unknown): Promise<CentreResult> {
    const envelope = bridgeMessageSchema.parse(input);
    const sender = envelope.sender;

    if (sender.system !== "NuN") {
      throw new Error("CENTRE_INGRESS_REQUIRES_CONNECTED_SUBSYSTEM");
    }

    const identity = this.identities.resolve(sender.system, sender.nodeId, sender.keyId);
    if (!identity || identity.version !== sender.version) {
      throw new Error("CENTRE_IDENTITY_NOT_TRUSTED");
    }

    const message = verifyBridgeMessage(envelope, identity.publicKey);
    // Scope sequence state to system + node + key, not node ID alone.
    this.sequences.accept(`${sender.system}:${sender.nodeId}:${sender.keyId}`, message.sequence);
    this.audit.append("INGRESS_AUTHENTICATED", message.messageId, {
      system: sender.system,
      nodeId: sender.nodeId,
      keyId: sender.keyId,
      messageType: message.messageType,
      sequence: message.sequence,
      contentHash: message.provenance.contentHash,
    });

    const stages: Record<string, StageResult> = {};
    const context = (): StageContext => ({ message, prior: Object.freeze({ ...stages }) });
    const ordered = [
      ["MIRROR", this.pipeline.mirror],
      ["CRITIC", this.pipeline.critic],
      ["EVIDENCE", this.pipeline.evidence],
      ["SYNTHESIS", this.pipeline.synthesis],
    ] as const;

    for (const [name, run] of ordered) {
      try {
        const result = await run(context());
        stages[name] = result;
        this.audit.append(`${name}_COMPLETED`, message.messageId, {
          evidenceRefs: result.evidenceRefs ?? [],
          objections: result.objections ?? [],
        });
      } catch (error) {
        this.audit.append("PIPELINE_STAGE_FAILED", message.messageId, {
          stage: name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const decision = stages.SYNTHESIS.decision ?? "QUARANTINE";
    const outcome: CentreOutcome = decision === "ACCEPT"
      ? "ACCEPTED_FOR_REVIEW"
      : decision === "REJECT"
        ? "REJECTED"
        : decision === "REQUEST_EVIDENCE"
          ? "MORE_EVIDENCE_REQUIRED"
          : decision === "PROPOSE_ACTION"
            ? "ACTION_REQUIRES_SEPARATE_AUTHORIZATION"
            : "QUARANTINED";

    this.audit.append("ORCHESTRATION_DECISION", message.messageId, {
      decision,
      outcome,
      actionExecuted: false,
      authorizationGranted: false,
    });

    return {
      messageId: message.messageId,
      correlationId: message.correlationId,
      sender: { system: sender.system, nodeId: sender.nodeId, keyId: sender.keyId },
      outcome,
      trust: "SIGNATURE_AND_IDENTITY_VERIFIED",
      stageOrder: ["MIRROR", "CRITIC", "EVIDENCE", "SYNTHESIS"],
      stages,
    };
  }
}
