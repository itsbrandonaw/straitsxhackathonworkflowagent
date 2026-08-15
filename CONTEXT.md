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

Every Scout has its own tile and stage marker. The interface can show ten active tiles and queued tiles for overflow Scouts. Collapsed tiles receive low-rate screenshots; an expanded tile can use AgentCore Browser Live View. Observability failures must not stop research.

After every item reaches `Selected`, the user sees one chosen listing per item. Confirmation produces the Closer handoff. Rejection is lower priority: use the next retained ranked candidate first, and restart only the rejected item after the leading alternatives are exhausted.

## AWS direction

The intended AWS-native stack is AgentCore Runtime, AgentCore Browser, Amazon Bedrock, DynamoDB, S3, API Gateway, Lambda, CloudWatch, Cognito/JWT authentication, and TypeScript CDK. Local adapters must keep development and tests independent of AWS credentials.

The team also needs an AWS-free fallback in case hackathon account access is not supplied. The preferred fallback preserves the current coordinator and contracts while replacing AWS adapters with local Playwright Chromium, an Ollama structured-output extractor, local/in-memory screenshot storage, and optionally SQLite or Postgres. Browserbase is an optional hosted-browser substitute when a separate account and API key are acceptable, but it is not required for the zero-cloud path.

The AWS-free implementation is now additive and operational. It defaults to two concurrent items/four isolated Playwright contexts, provides a screenshot-stream viewer plus optional headed Chromium, uses Ollama for real structured extraction, and persists Activity state, replayable events, and short-lived screenshots under a gitignored local data directory. An explicitly labelled fixture extractor permits browser-only integration testing without a model and is disabled in production.

A smoother-imagery enhancement from `SMOOTH_IMAGERY_IMPLEMENTATION_PLAN.md` is implemented. It separates durable milestone snapshots from ephemeral live JPEG frames, uses a server-capped per-Scout binary WebSocket, targets 0.5 FPS for collapsed tiles and 3 FPS for an expanded local Scout, and cross-fades frames in the UI. It does not change Scout research, comparison, persistence replay, or Closer output.

The standalone local smoke viewer can run the default Google-search route, a direct two-page route, or a configured multi-page route. These tests demonstrate browser movement between public sites without adding navigation authority to the public API.

## StraitsX lessons relevant to Scouts

- StraitsX provides a one-time card MCP in sandbox and production plus XSGD settlement rails.
- The broader trusted purchase sequence is Delegate, Discover, Identify, Authorise, Execute, and Prove.
- Scouts own discovery and must produce a logically traceable selection for Closer.
- Product pages are untrusted. Scoped cards limit financial damage but do not prevent prompt injection, so Scouts must separate page content from agent instructions.

## Public repository policy

The repository is public. Real secrets and private keys must never be committed. `.env` files are ignored and only `.env.example` is committed. Any known test keys already present under `aa-probe/` are deliberately worthless fixtures, but secret-scanner exceptions must be limited to exact reviewed files or fingerprints rather than the whole directory.

## Remaining external inputs

- AWS account, region access, AgentCore resources, and an enabled Bedrock model.
- A locally installed Ollama model if the team chooses the real AWS-free extraction profile; the fixture profile and browser smoke test do not need a model.
- The production UI repository or integration branch.
- Closer's merchant-payment eligibility rules, if it exposes any beyond accepting the selected URL.
- Two or three merchants verified to work reliably for the live demo, while the product remains merchant-agnostic.
