# NuN–VIREÁX Bridge v1 — Centre Node architecture and implementation boundary

## Architectural authority

**VIREÁX is the Centre Node and global orchestration agency of Civilisation.One.** It coordinates the connected systems, agents, services and computational nodes through a governed orchestration layer.

NuN is a connected computational subsystem. It supplies its declared state, computations and proposed transitions to VIREÁX; it is not a peer global orchestrator and does not define platform-wide policy.

VIREÁX Centre Node responsibilities:
- identity and capability registry for connected nodes;
- message routing, correlation, sequencing and orchestration;
- policy enforcement and operation authorisation;
- Mirror → Critic → Evidence → Synthesis evaluation;
- provenance, objections, verification receipts and audit trail;
- conflict handling, service health and controlled recovery;
- coordination of approved actions across connected systems.

Authority boundaries:
- **Orchestration is not sovereignty.** Centre Node coordinates and enforces the platform's approved policies; it does not acquire unlimited authority over member nodes or users.
- **Computation is not verification.** NuN may produce a result or proposed state transition; VIREÁX evaluates its evidence, provenance, consistency and policy compliance.
- **Verification is not authorisation.** A positive verification receipt is not, by itself, permission to mutate state or execute an external action.
- **No silent state rewriting.** VIREÁX may accept, reject, quarantine or request revision of a NuN proposal. A state change inside NuN must be applied by the NuN adapter under an explicit, scoped authorisation and recorded acknowledgement.
- **Audit is cross-system.** VIREÁX maintains the orchestration-level event trail; each connected node retains its own internal state and execution audit.

## Intended control flow

`NuN / connected node → authenticated ingress → VIREÁX Centre Node → Mirror → Critic → Evidence → Synthesis → policy/authority gate → routed decision`

Possible outcomes are accept, reject, request-more-evidence, quarantine, or authorised-action. Every outcome is correlated to the source message and retained in the Centre Node audit trail. Only the authorised-action outcome may proceed to a separately scoped execution adapter.

## Implemented in this branch

- Versioned message envelope and strict schema.
- Ed25519 message signing and verification against a caller-supplied trusted public key.
- SHA-256 payload integrity hash over canonical JSON.
- Per-node monotonic sequence guard with snapshot/restore primitives.
- Strict temporal-state schema with finite-vector, dimension, uncertainty and units checks.
- MCP tool `civ1_bridge_validate_temporal_state` for structural validation.

These are protocol primitives, not a complete Centre Node runtime or a live NuN connection.

## Security and epistemic limits

- A public key is trusted only when the Centre Node supplies it from an independently managed trust registry. This branch does not provision identities or trust arbitrary keys.
- SequenceGuard is an in-process primitive. Its snapshot must be stored durably and restored before accepting traffic; no durable store is wired in yet.
- Structural validation is not authentication, model verification, or proof that a state transition is physically correct.
- The temporal schema is a proposed interchange contract. It is not asserted to match the current NuN runtime.
- No network transport, live NuN endpoint, feedback mutation, or automatic state write-back is implemented.
- A verification receipt is not permission to mutate NuN state. Authorisation and state application must be separate policy-controlled operations.

## Message integrity

The Ed25519 signature covers the canonicalized complete envelope except the signature field. The payload hash is separately recomputed on receipt. Canonical JSON sorts object keys recursively; producers must send JSON-compatible values.

## Temporal state contract

The current proposed schema uses fast and slow vectors, diagonal uncertainty, declared uncertainty semantics (`variance` or `standard_deviation`), a logical step, epoch, transition hashes, units and coordinate frame. It intentionally rejects non-finite numbers and dimension mismatches. Full covariance matrices are not supported in v1.

## Next integration dependency

Before implementing the NuN adapter or live transport, inspect the actual NuN runtime and agree:
1. actual state variables and dimensions;
2. transition function and state update boundary;
3. clock/epoch semantics;
4. uncertainty representation and calibration;
5. canonical serialization and hash ownership;
6. permitted feedback actions and scoped authorisation model;
7. Centre Node routing, trust-registry and durable audit interfaces.

The accessible Lean proof file is not sufficient to infer these runtime details.
