# Security and safety baseline

## Prototype guarantees
- Input shape validation through Zod.
- No shell execution, arbitrary file access, outbound network calls, or external actions.
- No secrets required.
- Gate results are caller-supplied records, not self-verifying evidence.
- Mission data remains local to the process.

## Not provided
- Authentication or authorization.
- Durable or tamper-evident audit.
- Source authenticity verification.
- Rate limiting or quotas.
- Network transport hardening.
- Data retention controls.
- Isolation between multiple callers.

## Before production
1. Define threat model and data classifications.
2. Add identity-bound authorization per tool and mission.
3. Use a durable append-only event store with integrity checks.
4. Set input size and resource limits.
5. Validate and constrain any source URL resolver.
6. Add audit redaction and retention rules.
7. Run dependency, static, integration and adversarial tests.
8. Require explicit human approval for publication, memory commits, deployments and other consequential actions.
