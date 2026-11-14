# MCP-001 implementation boundary

This change preserves the CV1-SEC-001 freeze. MCP remains stdio-only, with in-memory mission state and no authentication service. No HTTP listener, network MCP transport, RAG retrieval, T3MP3ST coordinator, deployment, or agent self-grant is introduced.

## Canonical contracts
The `civ-intelligence-layer` submodule is pinned to commit `7de79ea01a75dd2b41f36fd641bee73540450d74`. MCP imports `KnowledgeRecord`, `RagEvidenceClass` and `RagSource` from its canonical `contracts/src/rag.ts`. Fields including `evidence_class`, `claim_id`, `valid_from`, `valid_to` and `supersedes_id` are not redefined here.

## Audit
Each MCP tool call is appended to a local JSONL audit file. Entries contain transport-derived actor identity (or the explicit unauthenticated marker), tool name, SHA-256 argument hash and result class. Raw arguments, results and secrets are not written. The log is opened in append-only mode with restrictive file permissions. An unavailable audit file blocks tool execution.

This is durable local logging, not a claim of tamper-proof or multi-process-safe production audit. The current stdio transport has no authenticated principal; the actor is therefore recorded as unauthenticated unless a trusted host integration injects an authenticated transport actor.

## Draft PR capability
`civ1_open_draft_pr` is registered with a fixed repository and base-branch scope. It accepts no token or credential fields. It has no merge, auto-merge, ready-for-review, publish, release or deployment operation. It requires both a transport-authenticated actor and an independently injected authorizer/executor. Because this repository currently has no authenticated transport, the default configuration fails closed and cannot open a PR. This is intentional; no model or tool argument can mint approval.

The executor interface returns only an open, draft, unmerged receipt. Human merge remains mandatory. No GitHub credential is configured or embedded by this change.

## Deferred
RAG retrieval/citation remain unavailable pending RAG-001 isolation acceptance. T3MP3ST remains reconnaissance only, not the coordinator. The Centre Node orchestration authority model is unchanged.
