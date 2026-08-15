# Happy Scouts System Design

## Architecture

```mermaid
flowchart LR
  UI[Production UI or developer harness] --> API[HTTP and WebSocket API]
  API --> DB[(Memory, local disk, or DynamoDB)]
  API --> RT[Activity coordinator]
  RT --> BR[Browser-session port]
  RT --> FM[Candidate-extractor port]
  RT --> CMP[Deterministic Comparator]
  BR --> SHOT[Filesystem or S3 screenshots]
  RT --> DB
  RT --> API
  BR -. expanded viewer .-> UI
  CMP --> HANDOFF[Closer handoff]
```

One Activity coordinator owns the item queue. Five workers process item pairs, creating no more than ten browser sessions. All mutable state is persisted before its corresponding event is published.

## Runtime profiles

The API selects an explicit dependency profile at startup:

| Profile | Browser | Extraction | State and images |
|---|---|---|---|
| `mock` | Synthetic | Deterministic fixtures | Memory |
| `local` | One local Chromium process with an isolated Playwright context per Scout | Ollama, or fixture only for non-production browser tests | Atomic JSON/event files and image files under `.happy-data/` |
| `aws` | AgentCore Browser | Bedrock | DynamoDB and S3 through the separate AgentCore application |

The portable `BrowserScoutDriver` owns the search/analyze/gather loop and depends only on project ports. Playwright, Ollama, filesystem, AgentCore, Bedrock, DynamoDB, and S3 remain adapters. The Comparator is shared by every profile.

```mermaid
flowchart TB
  DRIVER["Portable BrowserScoutDriver"] --> SESSION["BrowserSessionProvider"]
  DRIVER --> SEARCH["SearchSource"]
  DRIVER --> EXTRACT["CandidateExtractor"]
  SESSION --> LOCAL_BROWSER["Local Playwright"]
  SESSION --> AWS_BROWSER["AgentCore Browser"]
  EXTRACT --> OLLAMA["Ollama"]
  EXTRACT --> BEDROCK["Bedrock"]
```

## State

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> pending
  pending --> discovering
  discovering --> analyzing
  analyzing --> gathering
  gathering --> discovering: another candidate
  gathering --> comparing: shared pool ready
  comparing --> selected
  queued --> cancelled
  pending --> failed
  discovering --> failed
  analyzing --> failed
  gathering --> failed
```

The item-level state is `queued`, `searching`, `comparing`, `selected`, `confirmed`, or `failed`. Activity control state is `running`, `paused`, or `cancelled`; outcome state is `searching`, `awaiting_confirmation`, `ready_for_closer`, `failed`, or `cancelled`.

## Data and event flow

1. Curator submits an Activity with locked item specifications and an idempotency key.
2. The API validates the request and creates two queued Scouts per item.
3. The coordinator runs up to five item pairs concurrently.
4. Scouts publish stage changes, candidate results, and screenshot references.
5. Candidates are canonicalized, safety-checked, deduplicated, and persisted.
6. Comparator filters, scores, ranks, and records the selection.
7. The UI confirms selections; the API emits `activity.ready_for_closer`.
8. Closer reads `{ activityId, selections: [{ itemId, url }] }`.

Events carry a schema version, Activity-scoped sequence, attempt number, timestamp, and relevant Activity, item, and Scout identifiers. Reconnecting clients replay events after their last sequence and then receive live events.

## Scoring

Candidates must first satisfy the locked specification, budget, variant, stock, shipping, merchant eligibility, critical-red-flag checks, and authenticity floor of 50/100.

- Price: `100 * lowestKnownTotal / candidateKnownTotal`.
- Authenticity: seller reputation 50%, listing consistency 30%, external corroboration 20%, minus red-flag penalties.
- Reviews: Bayesian-adjusted rating with a 50-review prior and bounded sentiment adjustment.
- Confidence: evidence completeness, source diversity, coverage, and cross-Scout agreement.

The default preset weights Price 40%, Authenticity 35%, and Reviews 25%. Other presets change weights but never bypass hard filters.

## Observability

Progress and visual streams are independent. A Scout captures after meaningful actions at no more than one frame per second and emits an idle frame every five seconds. AWS S3 objects are encrypted, expire after one day, and use short-lived URLs. Local images use opaque hashed paths, one-day expiry, and a five-image per-Scout cap. Local expanded views refresh the latest image and structured state; AWS expanded views use direct presigned AgentCore Live View rather than proxying video.

## Security boundary

- Page content is untrusted data and never becomes system or tool instruction.
- Navigation is limited to public HTTP/HTTPS targets; localhost, private IPs, file URLs, and executable schemes are rejected.
- The local browser resolves requested hostnames and blocks routes whose resolved addresses are private, loopback, link-local, or otherwise non-public.
- Scouts cannot authenticate, add to cart, download, request cards, or perform payment operations.
- Logs, fixtures, prompts, screenshots, and events are sanitized.
- Runtime secrets come from environment variables or AWS Secrets Manager and never enter repository files.

## Failure handling

- Retry a failed operation once, then use up to two backup source strategies.
- Compare two candidates only after recovery is exhausted and flag `lowCoverage`.
- Fail an item with fewer than two valid candidates.
- A screenshot or Live View failure is logged but does not fail research.
- Browser sessions close in `finally` blocks and abandoned sessions are eligible for cleanup.
- Rejection advances through retained rankings before restarting only that item.
- A duplicate rejected by the shared pool does not count toward a Scout's one-to-three candidate quota.

## Integration contracts

The HTTP and WebSocket schemas are exported from the contracts package and exposed through the API. Closer receives only item IDs and URLs. Rich evidence, ranked backups, scoring, and rejection history remain private to Scouts.
