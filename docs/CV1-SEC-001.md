# CV1-SEC-001 — MCP security integration profile

**Status:** implementation design and boundary requirements. This document does not claim that authentication, persistence, remote connectivity or T3MP3ST execution has been implemented.

## Current trust boundary

The server currently uses MCP stdio and an in-memory `Civ1Domain`. Its tool handlers accept caller-supplied mission and evidence data. The current process does not establish a cryptographically authenticated actor, check per-tool authority, or persist a tamper-evident audit trail. Do not expose this prototype as a network service or treat a caller-supplied `actorId` as authenticated identity.

For local stdio deployments, the host process and operating-system account are part of the trust boundary. A future remote transport must add an authenticated transport identity before any tool can be considered protected.

## Required integration contract

The canonical request and receipt shapes are defined in the Intelligence Layer package:

- `contracts/src/capability.ts` — `CapabilityRequest`, `CapabilityExecutionReceipt`, and structural validators.
- Request schema: `c1.capability.request.v1`.
- Receipt schema: `c1.capability.receipt.v1`.

The MCP adapter must bind the authenticated principal from the transport/host to `actorId`; it must never trust an actor identifier supplied only in tool arguments. The gateway must independently check:

1. admitted identity and active credential/key status;
2. capability is registered and enabled;
3. requested target and action are within the exact scope;
4. scope and approval have not expired or been revoked;
5. approval binds the actor, capability/action, target scope, policy version and request/content hash where relevant;
6. data classification, budget, rate limit and concurrency ceilings;
7. replay/idempotency state and audit-store availability.

Any missing, malformed, expired or unavailable authority state must deny or defer before execution. Models and tool arguments cannot mint approvals.

## T3MP3ST adapter requirements

T3MP3ST is a specialised security-recon capability, not the VIREÁX coordinator. Its adapter must:

- accept only a validated `CapabilityRequest` and an independently verified authorization decision;
- translate exact approved asset identifiers into the T3MP3ST scope receipt format;
- reject target expansion, wildcard targets, redirects or DNS changes that escape the approved target policy;
- require explicit approval for active/high-risk actions; keep passive/read-only discovery separate;
- capture tool output, tool/version, timestamps, input/output hashes and evidence references;
- return a `CapabilityExecutionReceipt` for success, refusal, timeout, cancellation and failure;
- never treat model-generated findings as tool-proven evidence;
- keep credentials and secrets out of evidence and model context.

The adapter must not call the T3MP3ST MCP tool directly until its own handler-level authorization gap has been closed or an independently enforced local wrapper makes that boundary unavoidable.

## Durable audit requirements

The existing in-memory `Civ1Domain` audit array is not a durable audit store. Production adoption requires an append-only event interface compatible with VXP-INT-001, integrity verification on startup, fail-closed behaviour on corruption, atomic sequence allocation, and concurrency control. A checkpoint stored beside the log is not independently protected; production must retain checkpoints separately or use an independently protected signing/anchoring service.

Do not silently replace the VXP-INT-001 event format with a second audit chain. Map MCP mission, evidence, objection, authorization and execution events into the canonical contract.

## Delivery gates

- [ ] Authenticated principal supplied by trusted host/transport; no caller-asserted identity.
- [ ] Per-tool policy and approval verification with revocation and expiry.
- [ ] Durable append-only audit with startup integrity verification and multi-process safety.
- [ ] Exact-scope T3MP3ST adapter; no direct unrestricted MCP invocation.
- [ ] Receipt mapping and evidence provenance checks.
- [ ] Tests for unauthenticated caller, wrong actor, missing/revoked/expired approval, scope widening, wildcard target, replay, audit outage, timeout, cancellation and partial output.
- [ ] Cross-repository contract tests against the same pinned contract version.
- [ ] Human review and operational evidence before enabling remote or active execution.

## Explicit non-goals

This milestone does not connect NuN/LiGi, enable remote MCP, grant global authority, execute exploitation, publish findings, write member memory, or deploy any service. VIREÁX remains the orchestration coordinator; authority is enforced by a separate policy boundary.
