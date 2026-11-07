# KOL Escrow

Escrow for paid posts on X. A project locks each KOL's fee on NEAR. An agent checks the post, watches it through a hold window, then pays the KOL or refunds the project. Neither side can take the money back once it's locked.

Built for NEAR HACKATHON 2026. Live app: **https://kol-escrow.vercel.app** (NEAR testnet).

## The problem

Paid crypto promotion on X runs on trust and screenshots:

- KOLs post, get paid, then delete the post a few days later.
- KOLs with botted likes and replies get paid the same as KOLs with real reach.
- Projects delay or skip payment after the KOL has delivered.

## What it does

1. The project creates a campaign: the text the post must include, a deadline and a hold window.
2. The project funds it with a stablecoin and locks a fee per KOL (X handle, NEAR account, amount).
3. The agent finds each KOL's post on X and records it on-chain once it matches the terms.
4. The agent re-checks the post through the hold window. Deleted early means a refund to the project.
5. After the hold window, the agent samples the replies for bots, then pays the KOL or refunds the project.
6. A paid KOL can cash out to USDC or USDT on another chain (Base, Arbitrum, Solana, Ethereum and others) through NEAR Intents.

Every verdict is stored on-chain with its reason, so either side can see why money moved.

## Who can move the money

| Party | Can | Can't |
| --- | --- | --- |
| Agent | Confirm a post, pay the KOL's registered account, refund the project | Send funds anywhere else. Its only key is a function call key limited to `record_post`, `release`, `refund` |
| Project | Fund, add KOLs, withdraw money not yet assigned to a KOL | Pull back a locked fee |
| Anyone | Refund the project if no post was verified by the deadline plus a grace period. Pay the KOL if the post was verified and the agent stays silent after the hold window plus grace | Anything else |

The two timeouts mean a missing agent can't trap money in either direction.

## Try it (do X, see Y)

No install needed for steps 1 to 4.

1. **Open https://kol-escrow.vercel.app.** You see totals read live from the testnet contract (locked, paid, refunded) and the latest deal as a ticket.
2. **Open a campaign from the list.** Each KOL is a ticket showing its state (Locked, Posted, Holding, Paid or Refunded). Open **Agent record** to see each verdict, its reason and how it was checked.
3. **Open the contract on the explorer:** https://testnet.nearblocks.io/address/kolescrow2-1c4994.testnet. You see the `record_post`, `release` and `refund` calls from `kolagent2-1c4994.testnet` and the `tUSDC` transfers they caused.
4. **Check the agent's key:** on the explorer page for `kolagent2-1c4994.testnet`, open Access Keys. You see one function call key, limited to the escrow contract and those three methods, and no full access key.
5. **Create a campaign.** Connect a NEAR testnet wallet, open **New**, fill in the form with a 10 minute hold window and your own testnet account as the KOL, then press **Lock the fees**. Free tUSDC is minted to you in the same step. You land on the campaign page with your deal in Locked.
6. **See a cross-chain cash-out quote.** As a KOL with a paid deal, open **My deals**, pick for example USDC on Base, paste a Base address and press **Get a quote**. You see a live NEAR Intents quote (amount out, minimum after slippage, time). On testnet this is a preview priced with real USDC; sending works on mainnet. The same quote from the command line:

   ```sh
   curl "https://kol-escrow.vercel.app/api/quote?originAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAsset=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near&amount=100000000&refundTo=intents.near&recipient=0x2527D02599Ba641c19FEa793cD0F167589a0f10D"
   ```

   You get a JSON quote with `amountOutFormatted` close to 100 and a `timeEstimate` in seconds.

## Run it locally

Requires Rust (stable) and Node 22.

```sh
git clone https://github.com/Truthgeng/kol-escrow && cd kol-escrow

# Contract unit tests: 20 tests covering the happy path, early delete, late post,
# old post, storage deposits, both timeouts, double settle and failed transfers
cd contract && cargo test && cd ..

# Test token tests: 3 tests
cd test-token && cargo test && cd ..

# Agent tests: 12 tests for the decision rules and the bot check
cd agent && npm ci && npm test
```

**Run the agent against the live testnet contract without keys.** It reads every open deal, checks the sample posts in `fixtures/posts.json` instead of X, and prints what it would do without sending anything:

```sh
cd agent
ESCROW_CONTRACT=kolescrow2-1c4994.testnet X_MODE=fixture DRY_RUN=1 node src/run.js
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
| Storage staking | `create_campaign` and `add_deal` charge the caller for the storage they add, plus a reserve per deal for verdict records, and refund the rest |
| NEAR Intents, 1Click API | `web/api/*.js` and the cash-out panel: quotes, deposit address, status tracking |
| NEAR AI Cloud (optional) | `agent/src/judge.js`: judges whether a post meets the terms and stores the TEE signature for that request with the verdict |
| NEAR Connect | Wallet sign-in and transactions in the web app |

Tracks: Real-World Money, AI Security & Defense, Agent Economy, Autonomous Business.

## How it works

```
Project --ft_transfer_call--> Escrow contract <--record_post / release / refund-- Agent (function call key)
                                   |                                                 |
                                   |-- ft_transfer --> KOL's NEAR account            |-- X API: find post, check it's live, sample replies
                                   |-- ft_transfer --> Project (refund)              |-- NEAR AI Cloud: does the post meet the terms?
                                                                                     
KOL's NEAR account --ft_transfer--> 1Click deposit address --> USDC on Base, Solana, Arbitrum...
```

**Contract** (`contract/`). State per deal: Pending, Posted, Settling, Released, Refunded. `Settling` blocks a second payout while a transfer is in flight; a failed transfer rolls the deal back. The contract rejects a post made before the campaign started or after the deadline, and won't release before the hold window ends.

**Agent** (`agent/`). One pass looks at every open deal: for Pending deals it searches the KOL's recent posts for the required text; for Posted deals it checks the post is still live and, after the hold window, samples up to 30 replies and flags new accounts, accounts with almost no followers, and copy-paste replies. The decision logic is a pure function in `src/decide.js` with its own tests. The `agent` workflow runs a pass every 15 minutes on GitHub Actions, so no server is needed.

**Web app** (`web/`). Vite, no framework. Reads the contract over JSON-RPC, signs with NEAR Connect, and talks to 1Click through three small serverless routes on Vercel that accept a fixed request shape.

## Limits and trust

- **The agent's judgment is trusted.** The contract limits where money can go and when, but it can't check X itself. A faulty or dishonest agent could refund a KOL whose post was fine. The owner can rotate the agent with `set_agent`, and every verdict is public.
- **The TEE signature is stored, not fully verified.** When NEAR AI Cloud is on, the agent checks that the signed text covers its exact request and response, then stores the signature and signing address on-chain. Checking that address against NEAR AI's attestation report is not done yet. Without a NEAR AI key, verdicts are marked as a rule check.
- **The bot check is a heuristic.** It looks at account age, follower count and duplicate text. The threshold is set with `MAX_BOT_SHARE` (default 60% of sampled replies).
- **X recent search covers 7 days**, so a campaign's deadline should be within a week of its start, or the KOL's post should go up while the agent is running.
- **Testnet only.** The demo uses tUSDC, a free test token in `test-token/`. On mainnet a stablecoin such as native USDC needs the escrow and each KOL registered for storage on the token.
- **Storage from settled deals is not reclaimed yet.**

## Repository layout

```
contract/     escrow contract (Rust) and unit tests
test-token/   tUSDC, a free NEP-141 test token for the demo
agent/        the checking agent, deploy and end-to-end scripts, tests
web/          the web app and /api routes for NEAR Intents
.github/      contract build, testnet deploy with live test, scheduled agent
```

## Licence

MIT. See [LICENSE](LICENSE).
