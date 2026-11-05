# VIREÁX–LiGi Transport Adapter Contract v1

Status: **interface and contract proposal implemented in this repository; no live LiGi runtime binding or optical end-to-end test**.

## Authority and topology

VIREÁX is the Centre Node and global orchestration agency of Civilisation.One. NuN is a connected computational subsystem. LiGi is an optional transport adapter, not an orchestrator, identity authority, policy engine, or execution authority.

`NuN` → signed `NUN-VIREAX` envelope → `LiGiTransportPort` → optical/video transfer → `LiGiTransportPort` → original envelope → VIREÁX Centre Node → Mirror → Critic → Evidence → Synthesis.

The original Ed25519-signed bridge envelope remains end-to-end. LiGi encryption and ML-KEM may provide transport confidentiality, but do not replace the Centre Node's trusted identity registry or signature verification.

## Seven integration stages

1. **Boundary and ownership.** LiGi is behind `LiGiTransportPort`; it cannot make orchestration, policy, or execution decisions. The Centre Node remains the only global orchestrator.
2. **Authenticated pairing and key registration.** Pairing must be pinned to a pre-provisioned trusted identity/key record or a separately authenticated key-registration ceremony. An ML-KEM public key fingerprint or self-asserted pairing ticket is not identity authentication. No received pairing ticket may silently add a trusted VIREÁX identity.
3. **Signed session/message binding.** `encodeLiGiPacket` wraps the original signed `NUN-VIREAX` envelope with a session ID, message ID and SHA-256 packet hash. The wrapper is transport metadata; the original Ed25519 signature is still verified by `VireaxCentreNode.ingest`.
4. **Replay and duplicate protection.** The Centre Node's sequence guard remains authoritative after decoding. A transport adapter may suppress duplicate optical frames for efficiency, but must not replace persistent message/sequence replay protection. Production requires durable sequence state across restarts.
5. **Fragmentation, recovery and limits.** LiGi owns optical frame fragmentation/fountain recovery. The adapter accepts only a fully reconstructed packet, enforces a configurable maximum payload size (default 4 MiB), and rejects malformed/hash-mismatched packets. LiGi-specific retry/recovery policy must be implemented by the concrete port and tested against real camera/display captures.
6. **Timeouts and acknowledgement semantics.** Adapter operations receive an AbortSignal and default to a 30-second timeout. A valid `TRANSPORT_RECEIVED` ACK is bound to session ID, message ID and packet hash. It proves transport receipt only—not Centre Node acceptance, action authorisation, execution, or a NuN state commit. A state commit requires a separate signed NuN receipt containing the resulting state hash and transaction reference.
7. **End-to-end verification, key isolation and operational security.** Every received envelope must go through `VireaxCentreNode.ingest`. Keep LiGi KEM secret keys outside logs and API responses; protect the LiGi HTTP API with caller authentication, least privilege, rate limits and TLS before remote exposure. Add key rotation/revocation, durable replay storage, and durable audit before production.

## Adapter API

- `encodeLiGiPacket(message, sessionId)`: validates and wraps a bridge envelope.
- `decodeLiGiPacket(packet)`: validates packet framing/hash and returns the original bridge envelope. It does **not** authenticate the sender.
- `sendViaLiGi(port, message, sessionId)`: sends and validates a transport-only ACK.
- `receiveViaLiGi(port)`: receives a reconstructed packet. Caller must then invoke Centre Node ingress.

A concrete implementation must implement `LiGiTransportPort` using the LiGi repository's supported APIs. This repository intentionally does not import LiGi internals or copy its cryptographic code; the LiGi package is private/unlicensed in its current package metadata and should not be embedded as a dependency without an explicit licence and dependency review.

## Known LiGi implementation constraints from source inspection

- LiGi's agent API exposes ML-KEM key generation, session opening/reading and optical-frame generation.
- The current agent open result includes shared-secret material. Do not expose that result through a remotely reachable API or logs.
- ML-KEM establishes a shared secret; it does not authenticate the real-world identity of the peer.
- The photonic/lux handshake is a software hash construction, not quantum authentication or QKD.
- LiGi's optical frames are not a general-purpose network socket. The integration boundary is a transport port, not a claim of direct TCP/UDP connectivity.

## Verification status and production gate

Implemented here: packet schema, canonical message wrapping, SHA-256 packet integrity, session/message binding, packet-size limit, timeout/abort contract, ACK binding checks, and unit tests using a fake transport.

Not established: real optical transfer between two devices, compatibility with a specific LiGi deployment/API, authenticated pairing ceremony, durable replay protection, production key custody, remote API hardening, durable commit receipts, or production readiness.

Do not mark this integration production-ready until a concrete LiGi port passes hardware-in-the-loop tests, two-way optical recovery tests, packet-loss/reordering tests, replay tests across process restarts, and a separate state-commit receipt verification test.
