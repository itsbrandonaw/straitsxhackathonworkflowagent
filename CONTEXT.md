# Happy Scouts Context

## Product

Happy is a chat-first AI shopping concierge for the StraitsX AI Commerce Agents hackathon track. A Concierge interprets the request, a Curator locks each item specification with the user, Scouts discover and compare listings, and a separate Closer purchases confirmed selections using the StraitsX card-issuance MCP and XSGD settlement.

This repository owns only the Scouts workflow and its handoff to Closer. It does not issue cards, handle wallet credentials, automate checkout, or settle payments.

## Team boundary

- Another teammate owns the production UI/UX.
- Another teammate owns Closer and needs one shopping URL associated with each selected item.
- This repository provides the Scouts backend, typed UI contracts, observability streams, and a diagnostic developer harness.
- JavaScript/TypeScript is preferred throughout.

## Confirmed Scout behaviour

- Two Scouts are assigned to every item.
- Scout A favors broad queries, mainstream marketplaces, and large retailers.
- Scout B favors specialist, independent, and category-specific sources with different queries.
- Up to five items and ten Scouts run concurrently. Extra item pairs remain queued.
- Each Scout gathers one to three unique valid candidates, normally two.
- The shared pool normally contains three to five candidates and can contain up to six.
- Candidates are evaluated on price, authenticity, and reviews after hard specification and safety filters.
- A deterministic Comparator performs final ranking; an extra comparison agent is not used.
- Useful candidates and ranked alternatives remain stored after selection.

## Pipeline and experience

The visible Scout pipeline is:

`Pending -> Discovering -> Analyzing -> Gathering -> Discovering... -> Comparing -> Selected`

Every Scout has its own tile and stage marker. The interface can show ten active tiles and queued tiles for overflow Scouts. Active production tiles use read-only AgentCore Browser Live View directly; optional screenshots are retained only for internal evidence or diagnostics. Observability failures must not stop research.

After every item reaches `Selected`, the user sees one chosen listing per item. Confirmation produces the Closer handoff. Rejection is lower priority: use the next retained ranked candidate first, and restart only the rejected item after the leading alternatives are exhausted.

## AWS direction

The sole real-agent stack is AgentCore Runtime, AgentCore Browser, Amazon Bedrock, DynamoDB, S3, API Gateway, Lambda, CloudWatch, Cognito/JWT authentication, and TypeScript CDK. Each active Scout receives an AgentCore Browser session and connects through Playwright/CDP. Bedrock extracts structured evidence from untrusted page content; deterministic TypeScript performs the final comparison.

The earlier AWS-free Playwright/Ollama and Browserbase contingency has been withdrawn. The in-memory mock remains only for unit tests, coordinator validation, contract testing, and UI development. It does not browse real websites and must not be presented as a production fallback.

AgentCore deployment uses the public repository as build input from a trusted checkout. AgentCore does not clone GitHub or receive repository credentials. The official CLI remotely builds a Linux ARM64 container from a gitignored staging context containing only the committed Dockerfile and required Scout sources, while account IDs, model IDs, role ARNs, bucket names, endpoints, and deployment state remain untracked.

## StraitsX lessons relevant to Scouts

- StraitsX provides a one-time card MCP in sandbox and production plus XSGD settlement rails.
- The broader trusted purchase sequence is Delegate, Discover, Identify, Authorise, Execute, and Prove.
- Scouts own discovery and must produce a logically traceable selection for Closer.
- Product pages are untrusted. Scoped cards limit financial damage but do not prevent prompt injection, so Scouts must separate page content from agent instructions.

## Public repository policy

The repository is public. Real secrets and private keys must never be committed. `.env` files are ignored and only `.env.example` is committed. Any known test keys already present under `aa-probe/` are deliberately worthless fixtures, but secret-scanner exceptions must be limited to exact reviewed files or fingerprints rather than the whole directory.

## Remaining external inputs

- AWS account, region access, AgentCore resources, and an enabled Bedrock model.
- The production UI repository or integration branch.
- Closer's merchant-payment eligibility rules, if it exposes any beyond accepting the selected URL.
- Two or three Singapore or Singapore-shipping merchants verified to work reliably from AgentCore Browser on the judging network, while the product remains merchant-agnostic.
