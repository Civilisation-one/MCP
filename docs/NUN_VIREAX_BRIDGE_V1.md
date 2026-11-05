# NuN–VIREÁX Bridge v1 — implementation boundary

## Implemented in this branch

- Versioned message envelope and strict schema.
- Ed25519 message signing and verification against a caller-supplied trusted public key.
- SHA-256 payload integrity hash over canonical JSON.
- Per-node monotonic sequence guard with snapshot/restore primitives.
- Strict temporal-state schema with finite-vector, dimension, uncertainty and units checks.
- MCP tool `civ1_bridge_validate_temporal_state` for structural validation.

## Security and epistemic limits

- A public key is trusted only when the host supplies it from an independently managed trust registry. This branch does not provision identities or trust arbitrary keys.
- SequenceGuard is an in-process primitive. Its snapshot must be stored durably and restored before accepting traffic; no durable store is wired in yet.
- Structural validation is not authentication, model verification, or proof that a state transition is physically correct.
- The temporal schema is a proposed interchange contract. It is not asserted to match the current NuN runtime.
- No network transport, live NuN endpoint, feedback mutation, or automatic state write-back is implemented.
- Do not accept a verification receipt as permission to mutate NuN state. Authorization and state application must be separate policy-controlled operations.

## Message integrity

The Ed25519 signature covers the canonicalized complete envelope except the signature field. The payload hash is separately recomputed on receipt. Canonical JSON sorts object keys recursively; producers must send JSON-compatible values.

## Temporal state contract

The current proposed schema uses fast and slow vectors, diagonal uncertainty, declared uncertainty semantics (`variance` or `standard_deviation`), a logical step, epoch, transition hashes, units and coordinate frame. It intentionally rejects non-finite numbers and dimension mismatches. Full covariance matrices are not supported in v1.

## Next integration dependency

Before implementing the NuN adapter or bidirectional transport, inspect the actual NuN runtime and agree:
1. actual state variables and dimensions;
2. transition function and state update boundary;
3. clock/epoch semantics;
4. uncertainty representation and calibration;
5. canonical serialization and hash ownership;
6. permitted feedback actions and authorization model.

The accessible Lean proof file is not sufficient to infer these runtime details.
