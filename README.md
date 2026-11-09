# KOL Escrow

Escrow for paid posts on X. A project locks each KOL's fee on NEAR. An agent checks the post, watches it through a hold window, then pays the KOL or refunds the project. Neither side can take the money back once it's locked.

Built at NEAR HACKATHON 2026. Live app: **https://kol-escrow.vercel.app** (NEAR testnet). Demo video: see the demo post linked in the submission.

**Fastest look for a judge:**
- https://kol-escrow.vercel.app/#/c/2 is a finished campaign run with real posts on X: one KOL kept the post up and was paid, the other deleted it and the project was refunded. Open **Agent record** on each ticket for the reasons.
- https://kol-escrow.vercel.app/#/c/4 is open to applications with 100 tUSDC left. Connect a free test wallet and apply (step 7 below).
- `https://kol-escrow.vercel.app/#/me?as=<account>` shows any KOL's deals read-only, for example `#/me?as=kolkola-1c4994.testnet`.

## The problem

Paid crypto promotion on X runs on trust and screenshots:

- KOLs post, get paid, then delete the post a few days later.
- KOLs with botted likes and replies get paid the same as KOLs with real reach.
- Projects delay or skip payment after the KOL has delivered.

## What it does

1. The project creates a campaign: the text the post must include, a deadline and a hold window.
2. The project locks the money up front, in a stablecoin. Two ways to pick KOLs:
   - **Open budget.** KOLs find the campaign, see the budget is already locked, and apply with their X handle, their price and a short pitch. The project accepts or rejects. Accepting moves that KOL's fee from the budget into a deal for them. A project can only accept what it has already locked.
   - **Direct.** The project adds a KOL it already works with (X handle, NEAR account, fee).
3. The KOL posts on X and submits the link in the app. The contract stores it, and the agent can only confirm that exact post.
4. The agent checks the post is by that KOL, includes the required text and went up between the campaign start and the deadline, then records it on-chain.
5. The agent re-checks the post through the hold window. Deleted early, or edited so the required text is gone, means a refund to the project. Still up and unchanged at the end means the KOL is paid.
6. A paid KOL can cash out to USDC or USDT on another chain (Base, Arbitrum, Solana, Ethereum and others) through NEAR Intents.

Every verdict is stored on-chain with its reason, so either side can see why money moved.

### Checking X for free

By default the agent uses X's public embed service, which needs no API key and costs nothing. It confirms a submitted post exists, who wrote it and what it says, and a deleted post comes back as not found. The exact post time is read from the post id itself (X ids encode their creation time in milliseconds).

The free check can't see views, likes or replies. With a paid X API token (`X_BEARER_TOKEN`), the agent switches to the API on its own and adds a reply bot check: it samples up to 30 replies and flags new accounts, accounts with almost no followers, and copy-paste replies.

## Who can move the money

| Party | Can | Can't |
| --- | --- | --- |
| KOL | Apply to a campaign with their price, withdraw an open application. Submit or change the link to their post until it's confirmed or the deadline passes | Touch the money |
| Agent | Confirm the post the KOL submitted, pay the KOL's registered account, refund the project | Send funds anywhere else. Its only key is a function call key limited to `record_post`, `release`, `refund` |
| Project | Fund, add KOLs, accept or reject applications, withdraw money not yet assigned to a KOL | Pull back a locked fee, or accept more than it has locked |
| Anyone | Refund the project if no post was verified by the deadline plus a grace period. Pay the KOL if the post was verified and the agent stays silent after the hold window plus grace | Anything else |

The two timeouts mean a missing agent can't trap money in either direction.

## Try it (do X, see Y)

No install needed for steps 1 to 5.

1. **Open https://kol-escrow.vercel.app.** You see totals read live from the testnet contract (locked, paid, refunded) and the latest deal as a ticket.
2. **Open a campaign from the list.** Each KOL is a ticket showing its state (Locked, Posted, Holding, Paid or Refunded). Open **Agent record** to see each verdict, its reason and how it was checked.
3. **Open the contract on the explorer:** https://testnet.nearblocks.io/address/kolescrow4-1c4994.testnet. You see the `record_post`, `release` and `refund` calls from `kolagent4-1c4994.testnet` and the `tUSDC` transfers they caused.
4. **Check the agent's key:** on the explorer page for `kolagent4-1c4994.testnet`, open Access Keys. You see one function call key, limited to the escrow contract and those three methods, and no full access key.
5. **Check a real post the way the agent does.** Run `cd agent && npm ci && node scripts/check-post.js https://x.com/heistruthX/status/2119766985303351688` (no keys needed). It prints the post's real author, its creation time read from the id, its text and whether it's live. In a fork, the `agent` workflow does the same with a link in `post_url`.
6. **Connect.** Press **Connect wallet** and pick **Use a free test wallet**, optionally type a name, and press **Create and connect**. The site makes a funded `.testnet` account for you; its key stays in your browser. Or pick **Use my NEAR wallet** if you already have a testnet account in Meteor, Intear or another NEAR wallet.
7. **Run a campaign with applications.** Open **New**, set an open budget (say 300) and a 10 minute hold window, and press **Lock the money**. Free tUSDC is minted to you in the same step. You land on the campaign page, now marked **Open to apply** on the home page. In a second browser (or a private window, which gets its own test wallet), open the campaign and apply with your X handle and a fee. Back as the project, press **Accept and lock**: the fee moves into a deal and the ticket appears in Locked. As the KOL, post on X with the required text, open **My deals**, paste the link into **Submit post**, and within 15 minutes the agent moves the deal to Holding.
8. **See a cross-chain cash-out quote.** As a KOL with a paid deal, open **My deals**, pick for example USDC on Base, paste a Base address and press **Get a quote**. You see a live NEAR Intents quote (amount out, minimum after slippage, time). On testnet this is a preview priced with real USDC; sending works on mainnet. The same quote from the command line:

   ```sh
   curl "https://kol-escrow.vercel.app/api/quote?originAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAsset=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near&amount=100000000&refundTo=intents.near&recipient=0x2527D02599Ba641c19FEa793cD0F167589a0f10D"
   ```

   You get a JSON quote with `amountOutFormatted` close to 100 and a `timeEstimate` in seconds.

## Run it locally

Requires Rust (stable) and Node 22.

```sh
git clone https://github.com/Truthgeng/kol-escrow && cd kol-escrow

# Contract unit tests: 39 tests covering the happy path, early delete, late post,
# old post, KOL-submitted posts, storage deposits, both timeouts, double settle, failed transfers,
# applications (apply, accept, reject, withdraw, budget limits), one post per deal, and the state migration
cd contract && cargo test && cd ..

# Test token tests: 3 tests
cd test-token && cargo test && cd ..

# Agent tests: 16 tests for the decision rules (including edited posts), post time from id, embed parsing and the bot check
cd agent && npm ci && npm test
```

**Run the agent against the live testnet contract without keys.** It reads every open deal, checks the sample posts in `fixtures/posts.json` instead of X, and prints what it would do without sending anything:

```sh
cd agent
ESCROW_CONTRACT=kolescrow4-1c4994.testnet X_MODE=fixture DRY_RUN=1 node src/run.js
```

You see one line per open deal, for example `deal 0 @kol_a_demo: refund (No post matching the terms went up before the deadline)`.

**Run the web app:**

```sh
cd web && npm ci && npm run dev
```

**Reproduce the whole testnet setup on your own fork.** Add a repository secret `KEY_SEED` (any random text, 30+ characters), then run the `deploy-testnet` workflow. It derives every account and key from that one secret, creates the accounts with the testnet faucet, deploys both contracts, gives the agent its limited key, deletes the agent's full access key, and runs a live end-to-end test: two KOLs post, one deletes, and the test checks that one is paid 100 tUSDC and the project is refunded 100 tUSDC. The results appear on the run's summary page.

## NEAR tools used

| Tool | Where |
| --- | --- |
| Rust smart contract, `near-sdk` 5 | `contract/src/lib.rs`: campaigns, deals, verdicts, timeouts |
| NEP-141 `ft_transfer_call` | Projects fund campaigns by sending tokens with `{"campaign_id": N}` |
| Function call access keys | The agent's only key can call `record_post`, `release`, `refund` on the escrow and nothing else |
| Storage staking | `create_campaign`, `add_deal`, `apply` and `accept_application` charge the caller for the storage they add, plus a reserve per deal for verdict records, and refund the rest |
| NEAR Intents, 1Click API | `web/api/*.js` and the cash-out panel: quotes, deposit address, status tracking |
| NEAR AI Cloud (optional) | `agent/src/judge.js`: judges whether a post meets the terms and stores the TEE signature for that request with the verdict |
| NEAR Connect | Wallet sign-in and transactions in the web app |

Tracks: AI Security & Defense (`security`), Real-World Money (`realworld`), Agent Economy (`agents`).

## Built during the hackathon

- All code in this repository was written during NEAR HACKATHON. The first commit is on 2026-11-07; there is no earlier product or code.
- Libraries: `near-sdk` 5 (contract and test token), `near-api-js` 7 (agent, scripts, test wallet), `@hot-labs/near-connect` (wallet sign-in), Vite (web build), Playwright (demo recordings), `cargo-near` (wasm build). No templates or boilerplate.
- Most of the code was written with an AI coding assistant (Claude), directed and reviewed by the team.
- This is the team's only NEAR HACKATHON project.

## How it works

```
Project --ft_transfer_call--> Escrow contract <--record_post / release / refund-- Agent (function call key)
                                   |                                                 |
                                   |-- ft_transfer --> KOL's NEAR account            |-- X: free embed check (or paid API with reply sampling)
                                   |-- ft_transfer --> Project (refund)              |-- NEAR AI Cloud: does the post meet the terms?
                                                                                     
KOL's NEAR account --ft_transfer--> 1Click deposit address --> USDC on Base, Solana, Arbitrum...
```

**Contract** (`contract/`). State per deal: Pending, Posted, Settling, Released, Refunded. `Settling` blocks a second payout while a transfer is in flight; a failed transfer rolls the deal back. The contract rejects a post made before the campaign started or after the deadline, and won't release before the hold window ends.

**Agent** (`agent/`). One pass looks at every open deal: for Pending deals it checks the post the KOL submitted (or, with the paid API, searches the KOL's recent posts for the required text); for Posted deals it checks the post is still live and, with the paid API, samples replies after the hold window. The decision logic is a pure function in `src/decide.js` with its own tests. The `agent` workflow runs a pass every 15 minutes on GitHub Actions, so no server is needed.

**Web app** (`web/`). Vite, no framework. Reads the contract over JSON-RPC and signs with NEAR Connect. On testnet it also offers a built-in test wallet: it creates a key in the browser, asks NEAR's public testnet helper (through `api/faucet.js`, testnet names only) to create a `.testnet` account for that key, either one the visitor names or a random `kolguest-…` one, and signs with near-api-js. It talks to 1Click through three small serverless routes on Vercel that accept a fixed request shape.

**Upgrades.** The live testnet contract was upgraded in place to add applications: the `upgrade-testnet` workflow deploys the new code and calls `migrate` in one transaction, which keeps every earlier campaign and deal. One post can only ever pay one deal, so a KOL who applies under someone else's handle can't claim a post that already counted.

## Limits and trust

- **The agent's judgment is trusted.** The contract limits where money can go and when, but it can't check X itself. A faulty or dishonest agent could refund a KOL whose post was fine. The owner can rotate the agent with `set_agent`, and every verdict is public.
- **The TEE signature is stored, not fully verified.** When NEAR AI Cloud is on, the agent checks that the signed text covers its exact request and response, then stores the signature and signing address on-chain. Checking that address against NEAR AI's attestation report is not done yet. Without a NEAR AI key, verdicts are marked as a rule check.
- **The free X check can't see engagement.** Views, likes and reply quality need the paid X API. With it, the bot check is a heuristic on account age, follower count and duplicate text, set with `MAX_BOT_SHARE` (default 60% of sampled replies).
- **The free check depends on X's embed service.** If X changes or limits it, the agent reports an error for that deal and tries again on the next pass. It never pays or refunds on an error.
- **Testnet only.** The demo uses tUSDC, a free test token in `test-token/`. On mainnet a stablecoin such as native USDC needs the escrow and each KOL registered for storage on the token.
- **A KOL's handle on an application is self-declared.** The project should check the X profile before accepting. The agent only pays for a post from that handle, so an impostor can't get paid unless they control the account.
- **The test wallet is for testnet only.** Its key lives in the browser's storage. Clearing site data loses it.
- **Storage from settled deals is not reclaimed yet.**
- **Mainnet is prepared, not live.** `agent/scripts/deploy-mainnet.js` and the `deploy-mainnet` workflow (which asks for a typed confirmation) are there for a later launch with native USDC. They were never run; everything in the demo is on testnet.

## Repository layout

```
contract/     escrow contract (Rust) and unit tests
test-token/   tUSDC, a free NEP-141 test token for the demo
agent/        the checking agent, deploy and end-to-end scripts, tests
web/          the web app, /api routes for NEAR Intents and the testnet faucet
demo/         scripts that recorded the demo video
.github/      contract build, testnet deploy and upgrade with live tests, scheduled agent
```

## Licence

MIT. See [LICENSE](LICENSE).
