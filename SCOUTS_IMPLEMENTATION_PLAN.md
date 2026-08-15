# Happy Scouts Implementation Plan

## Outcome

Deliver a TypeScript backend that accepts locked item specifications, schedules two Scouts per item with a ten-Scout cap, gathers one to three candidates per Scout, compares a shared deduplicated pool deterministically, streams truthful progress and direct read-only AgentCore Live View, and emits one confirmed `{ itemId, url }` per item.

## Delivery

1. Establish public-repository safety, documentation, typed contracts, and AWS deployment configuration.
2. Implement the state machine, candidate normalization, deterministic scoring, and security guards.
3. Implement asynchronous coordination, queueing, retries, event sequencing, confirmation, handoff, and retained-candidate rejection.
4. Expose the website's `/v1/runs/*` control contract, authenticated callbacks, WebSocket APIs, and a minimal React developer harness.
5. Add DynamoDB, S3, AgentCore Runtime/Browser interfaces, CDK infrastructure, and CloudWatch-ready structured logs.
6. Add the stable viewer-capability exchange and AWS `BrowserLiveView`; signed DCV URLs stay out of callbacks and browser video connects directly to AgentCore.
7. Validate unit, integration, contract, security, concurrency, replay, callback retry, viewer expiry, and build behaviour.

## Acceptance

- Six submitted items create twelve Scout records while only ten become active.
- Each Scout gathers one to three candidates and emits truthful pipeline transitions.
- Each normal comparison has at least three unique pooled candidates; exhausted recovery may select from two with `lowCoverage`.
- Scoring is deterministic and authenticity never falls below the eligibility floor.
- Web content cannot instruct the agent to purchase, reveal secrets, or navigate to unsafe URLs.
- AgentCore Live View is the primary tile feed; it is read-only, refreshes signed connections, and its failure does not fail research.
- Stage callbacks contain real `0 -> 1 -> 2 -> 0` discovery loops, serialize item progress, and publish only after the underlying state is durable.
- Screenshots are optional internal evidence or diagnostics and are not a UI streaming requirement.
- Confirmed items yield exactly one item-associated URL to Closer.
- Unit and mock integration validation runs without AWS credentials and no tracked file contains a real secret.
- The real-browser smoke test runs through AgentCore Browser and Bedrock; no non-AWS real-agent runtime is maintained.
