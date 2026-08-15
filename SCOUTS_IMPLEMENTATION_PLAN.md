# Happy Scouts Implementation Plan

## Outcome

Deliver a TypeScript backend that accepts locked item specifications, schedules two Scouts per item with a ten-Scout cap, gathers one to three candidates per Scout, compares a shared deduplicated pool deterministically, streams progress and imagery, and emits one confirmed `{ itemId, url }` per item.

The AWS-native delivery remains the primary implementation. The additive no-AWS contingency is specified separately in [`AWS_FREE_IMPLEMENTATION_PLAN.md`](./AWS_FREE_IMPLEMENTATION_PLAN.md).

## Delivery

1. Establish public-repository safety, documentation, typed contracts, and local configuration.
2. Implement the state machine, candidate normalization, deterministic scoring, and security guards.
3. Implement asynchronous coordination, queueing, retries, event sequencing, confirmation, handoff, and retained-candidate rejection.
4. Expose HTTP/WebSocket APIs and a minimal React developer harness.
5. Add DynamoDB, S3, AgentCore Runtime/Browser interfaces, CDK infrastructure, and CloudWatch-ready structured logs.
6. Validate unit, integration, contract, security, concurrency, replay, and build behaviour.

## Acceptance

- Six submitted items create twelve Scout records while only ten become active.
- Each Scout gathers one to three candidates and emits truthful pipeline transitions.
- Each normal comparison has at least three unique pooled candidates; exhausted recovery may select from two with `lowCoverage`.
- Scoring is deterministic and authenticity never falls below the eligibility floor.
- Web content cannot instruct the agent to purchase, reveal secrets, or navigate to unsafe URLs.
- Browser imagery failures do not fail research.
- Confirmed items yield exactly one item-associated URL to Closer.
- Local validation runs without AWS credentials and no tracked file contains a real secret.
