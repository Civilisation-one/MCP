# VIREÁX Centre Node Control Plane v1

## Architectural position

VIREÁX is the Centre Node and global orchestration agency of Civilisation.One. NuN is a connected computational subsystem. It can provide computations, temporal-state proposals and capability declarations through an adapter, but it does not set global policy or authorise platform-wide actions.

This control plane implements a narrow in-process core. It is not yet a deployed global service.

## Ingress contract

The current ingress accepts a versioned `NUN-VIREAX` envelope and performs:

1. Strict envelope schema validation.
2. Explicit trusted-key lookup by `(system, nodeId, keyId)`.
3. Sender version match.
4. Ed25519 signature and payload-hash verification.
5. Monotonic sequence check scoped to `(system, nodeId, keyId)`.
6. Ordered orchestration through the review pipeline.

The identity registry is populated by trusted application configuration. There is deliberately no unauthenticated MCP tool that can add a trusted key.

## Review pipeline

The Centre Node calls injected stage providers in this exact order:

`Mirror → Critic → Evidence → Synthesis`

Each stage receives the verified message and a read-only view of prior stage outputs. A stage can return output, evidence references and objections. Synthesis returns one of:

- `ACCEPT`
- `REJECT`
- `QUARANTINE`
- `REQUEST_EVIDENCE`
- `PROPOSE_ACTION`

These are review outcomes, not claims that the source's underlying model is physically correct.

## Authority separation

A `PROPOSE_ACTION` synthesis result is translated into `ACTION_REQUIRES_SEPARATE_AUTHORIZATION`. This v1 core does not issue grants and does not execute external actions.

The invariant is:

`computation ≠ verification ≠ authorization ≠ execution`

A future policy service must issue an explicit, scoped, time-bounded grant. A separate adapter must enforce that grant and return an acknowledgement. No stage may bypass this gate.

NuN's internal state is outside VIREÁX's direct write authority. Any future write-back must be performed by the NuN adapter under an explicit scoped grant, with before/after state hashes and a NuN acknowledgement. No silent state rewriting is permitted.

## Audit

The current `MemoryAuditLedger` appends hash-linked events for authenticated ingress, each completed stage, stage failure and final orchestration decision. It is an in-memory integrity aid only: it is not durable, independently witnessed, or tamper-proof against a process owner.

## Implemented versus not implemented

Implemented in this repository:
- trusted identity registry API;
- signature and payload integrity verification at Centre Node ingress;
- replay guard scoped by system/node/key;
- ordered stage orchestration through injected interfaces;
- hash-linked in-memory audit events;
- action-proposal boundary that explicitly denies implicit authorisation/execution;
- unit tests for stage order, unknown identities, payload tampering, replay and action separation.

Not implemented:
- live network ingress or bidirectional NuN connection;
- actual NuN runtime adapter or verified NuN state schema;
- persistent identity/key store, key rotation or revocation;
- durable sequence/replay store;
- production audit ledger;
- concrete model/provider implementations for the four stages;
- policy-grant service or action executor;
- deployment, availability, scaling or disaster recovery.

## Next integration gate

Do not connect a live NuN runtime until its actual API, state schema, transition semantics, identity mechanism and acknowledgement behavior have been inspected and tested. A proposed JSON contract or Lean toy model is not sufficient evidence of a live runtime interface.
