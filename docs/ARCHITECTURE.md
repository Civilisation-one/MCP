# Architecture

## Scope
This repository is the MCP adapter boundary for Civilisation.One workflows. It exposes narrow typed tools over MCP stdio and separates orchestration from future providers.

## Components
- `src/index.ts`: MCP entrypoint and stdio transport.
- `src/server.ts`: tool definitions, schemas and JSON responses.
- `src/domain.ts`: in-memory mission, evidence, objection, gate and audit state.
- `test/domain.test.ts`: domain behavior tests.

## Trust boundaries
Caller inputs are untrusted. The adapter validates structure but does not authenticate external clients, prove source reliability, establish claim truth, or authorize real-world actions.

## Mission model
A mission contains an identifier, goal, constraints, creation time, status, evidence records, objections, gate records and ordered audit events. Source URIs are metadata only; they are not fetched or verified. Gate statuses are caller-supplied declarations.

## Limitations
- In-memory state only; restart loses data.
- No multi-user identity, authentication or authorization.
- No cryptographic integrity or signed provenance.
- No network transport or model-provider integration.
- No external side effects or production-readiness claim.

## Future integration
Implement provider interfaces and policy checks without changing domain semantics. Add durable storage and authorization before network exposure or consequential actions.
