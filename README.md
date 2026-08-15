# Happy Scouts

Happy Scouts is the discovery and comparison backend for Happy, an AI shopping concierge built for the StraitsX AI Commerce Agents hackathon track. It runs two complementary research Scouts per requested item, streams truthful progress and browser imagery, ranks eligible listings deterministically, and hands one confirmed shopping URL per item to the Closer service.

## What is implemented

- TypeScript contracts and Zod validation for Scout runs, events, candidates, state, and Closer handoff.
- A deterministic state machine and Comparator with four ranking presets.
- An asynchronous coordinator with five-item/ten-Scout concurrency and queued overflow items.
- Retained top-three alternatives and item-scoped re-search after those choices are rejected.
- Mock Scouts and in-memory adapters for local development without AWS credentials.
- Fastify HTTP and WebSocket APIs.
- A React developer harness for starting a six-item demo, watching Scout tiles, and inspecting events.
- AWS adapters and CDK infrastructure for DynamoDB, S3, WebSocket API Gateway/Lambda, and AgentCore invocation.
- Public-repository secret scanning and CI checks.

## Quick start

Requirements: Node.js 22 and pnpm 10.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The API defaults to `http://localhost:3001` and the developer harness to `http://localhost:5173`.

Useful commands:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm secrets:check
pnpm validate
```

## Documentation

- [Product context](./CONTEXT.md)
- [Implementation plan](./SCOUTS_IMPLEMENTATION_PLAN.md)
- [System design](./SYSTEM_DESIGN.md)
- [Non-technical walkthrough](./WALKTHROUGH.md)
- [OpenAPI contract](./openapi.yaml)

## AWS mode

Local mode is the default and uses mock browsers, candidates, screenshots, and in-memory persistence. AWS mode requires the environment variables documented in `.env.example`, deployed CDK resources, an AgentCore Runtime, an AgentCore Browser resource, and an enabled Bedrock model.

Never commit `.env`, AWS credentials, StraitsX credentials, wallet material, presigned URLs, or production secrets. Only `.env.example` is committed.
