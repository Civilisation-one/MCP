import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface TransportActor { subject: string; authenticated: true; }
export interface AuditRecord {
  at: string;
  sequence: number;
  who: string;
  tool: string;
  args_hash: string;
  result_class: string;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b));
    return "{" + entries.map(([k,v]) => JSON.stringify(k) + ":" + stable(v)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
export function hashToolArgs(args: unknown): string {
  return createHash("sha256").update(stable(args)).digest("hex");
}
/** Append-only JSONL audit. Records contain hashes and classifications, never raw arguments/results. */
export class AppendOnlyAudit {
  readonly path: string;
  private sequence = 0;
  constructor(path = process.env.CIV1_AUDIT_PATH ?? ".data/mcp-audit.jsonl") {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.assertWritable();
  }
  assertWritable(): void {
    const fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    closeSync(fd);
  }
  append(who: string, tool: string, args: unknown, resultClass: string): AuditRecord {
    this.assertWritable();
    const record: AuditRecord = {
      at: new Date().toISOString(), sequence: ++this.sequence, who, tool,
      args_hash: hashToolArgs(args), result_class: resultClass,
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    return record;
  }
}
