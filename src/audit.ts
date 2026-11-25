import { chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson, sha256 } from "./bridge/protocol.js";

/** Same genesis value as the civ-intelligence-layer AuditLedger (contracts/src/audit.ts). */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

export interface TransportActor { subject: string; authenticated: true; }
export interface AuditRecord {
  at: string;
  sequence: number;
  who: string;
  tool: string;
  args_hash: string;
  result_class: string;
  /** Hash of the previous record, or AUDIT_GENESIS_HASH for the first chained record. */
  previousHash: string;
  /** SHA-256 of canonicalJson(record without `hash`). */
  hash: string;
}
/** A head the host can store somewhere independent of the log, and later pass to verifyChain to detect truncation. */
export interface AuditCheckpoint { sequence: number; hash: string }
export interface AuditChainReport {
  valid: boolean;
  records: number;
  /** Records written before hash chaining existed (no previousHash/hash). Counted, not verifiable. */
  legacyRecords: number;
  head: AuditCheckpoint;
  reasonCodes: string[];
}

export function hashToolArgs(args: unknown): string {
  return sha256(canonicalJson(args));
}
export function auditRecordHash(record: Omit<AuditRecord, "hash">): string {
  return sha256(canonicalJson(record));
}

function parseLines(text: string): { lines: unknown[]; torn: boolean } {
  const raw = text.split("\n");
  const torn = raw.length > 0 && raw[raw.length - 1] !== "";      // last write did not finish with a newline
  const lines: unknown[] = [];
  for (const [i, line] of raw.entries()) {
    if (!line) continue;
    try { lines.push(JSON.parse(line)); }
    catch { lines.push({ __unparseable: i + 1 }); }
  }
  return { lines, torn };
}

/**
 * Verify a JSONL audit log. Checks every chained record's hash, its link to the previous record, and that
 * sequence numbers are consecutive. With a checkpoint, also detects truncation or rollback to an earlier head.
 * Legacy records (written before chaining) must all precede chained ones.
 */
export function verifyAuditChain(text: string, checkpoint?: AuditCheckpoint): AuditChainReport {
  const reasonCodes: string[] = [];
  const { lines, torn } = parseLines(text);
  if (torn) reasonCodes.push("torn_final_line");
  let previous = AUDIT_GENESIS_HASH;
  let sequence = 0;
  let legacy = 0;
  let chained = 0;
  for (const [i, value] of lines.entries()) {
    const n = i + 1;
    if (!value || typeof value !== "object" || "__unparseable" in (value as object)) { reasonCodes.push(`unparseable_record:${n}`); continue; }
    const r = value as Partial<AuditRecord>;
    if (r.hash === undefined && r.previousHash === undefined) {
      if (chained > 0) reasonCodes.push(`legacy_record_after_chain:${n}`);
      legacy++;
      if (typeof r.sequence === "number") sequence = Math.max(sequence, r.sequence);
      continue;
    }
    chained++;
    if (r.sequence !== sequence + 1) reasonCodes.push(`sequence_gap:${n}`);
    if (r.previousHash !== previous) reasonCodes.push(`broken_link:${n}`);
    const { hash, ...body } = r as AuditRecord;
    if (typeof hash !== "string" || auditRecordHash(body) !== hash) reasonCodes.push(`hash_mismatch:${n}`);
    previous = typeof hash === "string" ? hash : previous;
    sequence = typeof r.sequence === "number" ? r.sequence : sequence + 1;
  }
  const head = { sequence, hash: previous };
  if (checkpoint) {
    if (head.sequence < checkpoint.sequence) reasonCodes.push("truncated_before_checkpoint");
    else if (head.sequence === checkpoint.sequence && head.hash !== checkpoint.hash) reasonCodes.push("checkpoint_mismatch");
    else if (head.sequence > checkpoint.sequence) {
      // The checkpointed record must still be in the log with the same hash.
      const at = lines.find((v) => (v as AuditRecord)?.sequence === checkpoint.sequence) as AuditRecord | undefined;
      if (!at || at.hash !== checkpoint.hash) reasonCodes.push("checkpoint_mismatch");
    }
  }
  return { valid: reasonCodes.length === 0, records: chained, legacyRecords: legacy, head, reasonCodes };
}

/**
 * Append-only JSONL audit with a SHA-256 hash chain. Records contain hashes and classifications, never raw
 * arguments or results. On start it verifies the existing log and resumes the sequence and head hash from
 * it, so a restart never reuses sequence numbers. A log that fails verification is refused (fail closed).
 *
 * Single-writer only: two processes appending to one file can interleave and break the chain. Checkpoints
 * kept beside the log are not independently protected; store `checkpoint()` output elsewhere.
 */
export class AppendOnlyAudit {
  readonly path: string;
  private sequence = 0;
  private headHash = AUDIT_GENESIS_HASH;

  constructor(path = process.env.CIV1_AUDIT_PATH ?? ".data/mcp-audit.jsonl", options: { checkpoint?: AuditCheckpoint } = {}) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.assertWritable();
    const report = this.verify(options.checkpoint);
    if (!report.valid) {
      throw new Error(`audit log ${this.path} failed verification: ${report.reasonCodes.slice(0, 5).join(", ")}`);
    }
    this.sequence = report.head.sequence;
    this.headHash = report.head.hash;
  }

  assertWritable(): void {
    const fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try { chmodSync(this.path, 0o600); } finally { closeSync(fd); }
  }

  verify(checkpoint?: AuditCheckpoint): AuditChainReport {
    return verifyAuditChain(existsSync(this.path) ? readFileSync(this.path, "utf8") : "", checkpoint);
  }

  checkpoint(): AuditCheckpoint {
    return { sequence: this.sequence, hash: this.headHash };
  }

  append(who: string, tool: string, args: unknown, resultClass: string): AuditRecord {
    const body: Omit<AuditRecord, "hash"> = {
      at: new Date().toISOString(), sequence: this.sequence + 1, who, tool,
      args_hash: hashToolArgs(args), result_class: resultClass, previousHash: this.headHash,
    };
    const record: AuditRecord = { ...body, hash: auditRecordHash(body) };
    const fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try {
      chmodSync(this.path, 0o600);
      const data = Buffer.from(JSON.stringify(record) + "\n", "utf8");
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // Advance only after the record is durably written.
    this.sequence = record.sequence;
    this.headHash = record.hash;
    return record;
  }
}
