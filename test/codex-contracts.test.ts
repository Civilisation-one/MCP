import type { KnowledgeRecord, RagEvidenceClass } from "../src/codex-contracts.js";

// Compile-time assertion that MCP consumes the canonical contract field names and types.
type RequiredCodexFields = Pick<KnowledgeRecord, "evidence_class" | "claim_id" | "valid_from" | "valid_to" | "supersedes_id">;
const evidenceClass: RagEvidenceClass | null = null;
const canonicalFields: RequiredCodexFields = {
  evidence_class: evidenceClass,
  claim_id: null,
  valid_from: null,
  valid_to: null,
  supersedes_id: null,
};
void canonicalFields;
