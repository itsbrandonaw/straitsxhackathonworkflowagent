# Happy Scouts Walkthrough

## What the user experiences

Imagine asking Happy to help build a gaming PC. The Concierge understands the goal and the Curator confirms each component and budget. Once those choices are locked, the Scouts begin.

Every item gets two Scouts. One looks broadly across familiar marketplaces and large retailers. The other looks at specialist and independent sellers. They deliberately search differently so the user sees genuine coverage rather than duplicated work.

The search screen shows each Scout in its own small browser tile. A shared plot shows where every Scout is: discovering a listing, analyzing whether it really matches, gathering its evidence, comparing the shared shortlist, or selected. The marker can move back from gathering to discovering because the Scout is checking another candidate; that movement represents real work.

Only ten Scouts run at once. If the request contains more than five items, the extra Scout tiles remain visibly queued until a slot opens.

## How Happy avoids choosing the first result

Each Scout gathers between one and three useful listings. The two Scouts combine their findings, remove duplicates, and reject options that do not match the specification, exceed the budget, appear unavailable, cannot ship, or look suspicious.

The remaining listings receive explainable scores for price, seller/listing authenticity, and reviews. The calculation is ordinary deterministic code, not another agent guessing which result looks best. The model helps interpret messy page evidence, but it cannot change the scoring arithmetic.

## Live visibility

Every tile receives lightweight screenshots so all Scouts remain observable without streaming ten full videos. On AWS, expanding a Scout opens its AgentCore Live View. In the AWS-free setup, it opens a local page that refreshes the latest real Chromium screenshot and stage details. A developer can also run Chromium headed. If imagery temporarily fails, the Scout continues and its stage updates remain visible.

The same experience has three operating modes. Mock mode is fast and deterministic for UI work. Local-agent mode performs real browsing with Playwright and can use a local Ollama model, so it needs no AWS account or model API key. AWS mode uses the managed AgentCore, Bedrock, DynamoDB, and S3 services. The user-facing stages and Closer output stay the same in every mode.

## Selection and handoff

When an item reaches Selected, Happy retains the winner and ranked alternatives. After all items are selected, the user reviews one listing per item. Confirming all items creates the simple handoff Closer expects: the Activity ID plus one shopping URL for each item.

Closer then owns card issuance and checkout. Scouts never see card details or perform payment actions.

## Rejection

Happy first offers the next retained high-ranking candidate. After the first three ranked choices are exhausted, it restarts only the rejected item's Scouts, retains useful evidence, and excludes rejected candidate IDs. Other confirmed items remain completed and do not repeat their search.
