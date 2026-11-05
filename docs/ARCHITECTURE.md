# Architecture

## Authority model

**VIREÁX is the Centre Node and global orchestration agency of Civilisation.One.** Connected systems such as NuN are computational subsystems. They submit proposals and results; they do not become peer global orchestrators or acquire platform-wide policy authority.

The Centre Node coordinates identity, ingress, routing, review, evidence, policy boundaries and audit. This is orchestration, not sovereignty. Computation is not verification; verification is not authorisation; authorisation is not execution.

## Components

- `src/index.ts`: MCP entrypoint and stdio transport.
- `src/server.ts`: MCP tool definitions, schemas and JSON responses.
- `src/domain.ts`: in-memory mission, evidence, objection, gate and audit state.
- `src/bridge/protocol.ts`: versioned bridge envelope, Ed25519 signatures, payload hashing and replay-guard primitive.
- `src/bridge/state-validator.ts`: structural validation for a proposed NuN temporal-state interchange contract.
- `src/centre-node/control-plane.ts`: Centre Node ingress/orchestration core; trusted identity registry, signature verification, scoped sequence guard, ordered review pipeline and hash-linked in-memory audit.
- `test/`: domain, bridge and Centre Node tests.

## Centre Node ingress flow

`NuN → trusted identity lookup → signature and payload verification → replay check → Mirror → Critic → Evidence → Synthesis → audited outcome`

The review stages are dependency-injected interfaces. This repository does not pretend to contain the model implementations or an active NuN network adapter. The current core accepts signed envelopes in-process. It does not open a network listener or provide a durable message queue.

## Trust and authority boundaries

- NuN's message is untrusted until its identity is explicitly registered and its Ed25519 signature and payload hash verify.
- Sequence state is scoped to system, node and key ID. The current guard is process-memory only; it is not a durable anti-replay service.
- The four review stages are ordered. Their outputs and objections are retained in the orchestration result and audit events.
- A synthesis result of `PROPOSE_ACTION` becomes `ACTION_REQUIRES_SEPARATE_AUTHORIZATION`. The Centre Node core never executes the action and never treats synthesis as authorisation.
- A structural temporal-state pass does not validate the underlying physical model, its equations, or its truth.
- MCP stdio callers are not authenticated by this prototype. Do not expose it as a trusted multi-user service.

## Current limitations

- In-memory mission, identity, sequence and audit state; restart loses state.
- No durable database, queue, transactional outbox or distributed consensus.
- No network transport or live NuN runtime adapter.
- No production key-management service, key rotation or revocation workflow.
- No concrete model-backed Mirror/Critic/Evidence/Synthesis providers are wired in.
- No separate authorisation service or action executor.
- No claim of production readiness.

## Integration order

1. Inspect and bind to the real NuN runtime contract; do not infer it from a toy proof or proposed interchange schema.
2. Add durable identity/key management and anti-replay storage.
3. Add authenticated transport and message routing with correlation, timeout and retry semantics.
4. Connect model-backed review providers behind the four stage interfaces.
5. Add a separate policy/authority service and explicit scoped grants before any action adapter.
6. Add durable audit, recovery, observability and adversarial integration tests.
