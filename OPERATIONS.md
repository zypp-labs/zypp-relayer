# Relayer Operations

Runbooks for the Zypp relayer. Written 2026-08-02 alongside the outbound-verification
and spend-policy work; the fee-payer key sections were the prerequisite audit for
letting the relayer construct transactions.

Statements below marked **verified** were checked against the code or config.
Statements marked **unverified** could not be confirmed from the repository and
need someone with deploy access to close out.

---

## 1. Fee-payer key: where it lives today

**Verified from source:**

- `FEE_PAYER_SECRET_KEY` is a required env var, validated as a non-empty string
  (`src/lib/config.ts` — `z.string().min(1)`).
- It is parsed as a JSON array of bytes into a `Keypair` at two call sites:
  `src/lib/shunt.ts` (`processShunt`) and `src/worker/broadcast.ts`
  (`processIntentAndBroadcast`). Both parse it per invocation rather than once
  at startup, so the plaintext key is re-materialised in memory on every job.
- A local `.env` file exists in `zypp-relayer/` and `.env.example` lists
  `FEE_PAYER_SECRET_KEY=` as a required field. **Locally the key is plaintext on
  disk.**
- Deploy target is **Render**, configured through the Render dashboard. There is
  no `render.yaml` in the repo, so the service definition — build command, start
  command, environment variables, pre-deploy command — lives only in Render's UI
  and is not version-controlled. That is worth changing: a Render Blueprint
  (`render.yaml`) would make the deployment reviewable and reproducible, and
  would stop this document from being the only record of it.
- **`fly.toml` in the repo is stale.** It dates from April and describes an
  abandoned Fly.io deployment (app `zrn-api`, `auto_stop_machines`, a
  `release_command` running migrations). Nothing reads it. It should be deleted
  so it stops being mistaken for the live configuration — this runbook was
  originally written against it, and every secrets instruction was wrong as a
  result.

**Unverified — needs deploy access:**

- Whether the production key is actually set in Render's dashboard (Environment
  → Secret Files or Environment variables) and how. Confirm with someone who has
  Render dashboard access — there is no CLI command to list secrets without an
  API key.
- Whether `.env` has ever been committed. `git log --all --full-history -- .env`
  will say. If it has, the key in it must be treated as compromised and rotated
  regardless of anything else.

### There is no KMS or HSM

The key is a raw Ed25519 secret held in process memory, not a handle to an
external signer. Every process that can read the env var can sign arbitrary
transactions as the fee payer. Moving to a KMS or a remote signer would mean the
relayer never holds the private key — worth considering before the fee payer
holds meaningful balance, but out of scope for this pass.

---

## 2. Who can read it at runtime

**Verified:**

- The `api` process (`src/api/index.ts`) and the `worker` process
  (`src/worker/index.ts`) both call `loadConfig()`, so both hold the key in
  memory. The API process only needs it for the shunt path; the worker needs it
  for normal broadcasts.
- Anyone with access to Render's service environment can read it. On Render,
  "environment variables" are visible in the dashboard to anyone with the
  service's owner/editor access, and a value stored as a plain env var is
  readable by the running process at will. Render's **Secret Files** are the
  safer option for a signing key (written to a file at deploy time, not exposed
  as an env var), though either way the process must be able to read it. The
  practical upshot is the same as for any host: access to the deploy dashboard
  is equivalent to fee-payer key access.

### Logging exposure — checked and closed

Grepped for wholesale config or context logging. Findings:

- `loadConfig` failure path prints `parsed.error.flatten()`, which contains zod
  **field names and messages only, never the input values** — safe.
- `src/api/index.ts` logs `{ address }`; `src/worker/index.ts` logs
  `{ concurrency: config.BULL_CONCURRENCY }`. Neither logs the config object.
- `registerRoutes` receives the entire `Config` in its deps object, so a future
  `log.info({ config })` would have leaked everything.

`src/lib/logger.ts` now sets pino `redact` paths covering
`FEE_PAYER_SECRET_KEY`, `secretKey`, `SUPABASE_SERVICE_ROLE_KEY`,
`DATABASE_URL`, the Polar secrets, and the inbound `x-api-key` header. This is
defence in depth — the intent is that a careless future log line fails safe.

### Crash and error reporting

**Verified:** there is no Sentry, Bugsnag, or other error-reporting SDK in
`package.json`. Nothing ships stack traces off-box today, so there is no
third-party service holding fragments of the key.

Note for whenever one is added: `Keypair.fromSecretKey(Uint8Array.from(JSON.parse(...)))`
sits inside a `try` in both call sites, and a throw there produces a
`SyntaxError` from `JSON.parse` whose message can include a fragment of the
malformed input. Both sites currently catch and return a fixed string
(`FEE_PAYER_KEY_INVALID: ...`) without attaching the original error — keep it
that way.

---

## 3. Rotation

**Verified:** there is no rotation mechanism. No key-versioning, no dual-key
support, no rotation script. Rotation is manual and is the procedure below.

The relayer reads the key fresh on every job, so a restart is sufficient to pick
up a new value — no code change needed to rotate.

### Why rotation needs two keys, not one

Rotating the fee payer changes its **public key**, and a client bakes that
public key into the transaction message it signs. `coSignAsFeePayerWithKeys`
(`src/lib/feePayer.ts`) gates on the named fee payer being one the relayer
holds:

```
staticAccountKeys[0] must match one of the loaded fee-payer keys
  → else FEE_PAYER_MISMATCH, non-retriable
```

If the relayer held only one key, swapping it would make **every transaction a
client had already signed against the old key permanently unbroadcastable**. The
intent TTL is 120 days (`DEFAULT_INTENT_MAX_AGE_SECONDS` in
`src/lib/validateV1.ts`), so that window is not an edge case — over any real
operating period it is a certainty. Rotation would have been actively hazardous
to attempt, which also meant the standard response to a suspected key compromise
was itself broken.

**Resolved 2026-08-02.** The relayer accepts a *set* of fee-payer keys:

- `FEE_PAYER_SECRET_KEY` — the current key. Clients should name this one.
- `FEE_PAYER_LEGACY_SECRET_KEYS` — keys being rotated out. Still honoured for
  transactions that already name them; never advertised for new ones. For one
  key this is the keyfile's own JSON byte array, so `cat fee-payer-old.json`
  works directly. For several, an array of those: `[[1,2,…],[3,4,…]]`.

  **Not comma-separated.** A JSON byte array contains commas, so splitting on
  them shreds the key — the first implementation did exactly that and legacy
  keys silently failed to parse. Regression-tested in
  `src/lib/feePayerKeys.test.ts`.

Step 5 of the co-sign sequence selects whichever accepted key the transaction
names, and step 8 signs with that key — so a transaction signed weeks ago
against the previous key still settles. Rotation becomes a drain rather than a
cutover.

`loadFeePayerKeypairs` throws if any configured key fails to parse, and both
call sites treat that as fatal. A silently-dropped legacy key would strand
exactly the transactions it exists to rescue, so a partial key set is never
preferable to a hard failure.

### Procedure (routine, planned)

1. **Generate the new keypair offline.**
   ```
   solana-keygen new --no-bip39-passphrase -o /tmp/fee-payer-new.json
   solana-keygen pubkey /tmp/fee-payer-new.json
   ```

2. **Fund it with SOL for fees.** It pays for every relayed transaction, and
   ATA creation if a recipient has never held the asset (see A2 in
   `to-be-fixed.md` — nothing currently creates recipient ATAs, so a payment to
   a fresh recipient fails at broadcast).

3. **Promote the new key and demote the old one in a single change.** The old
   key moves to the legacy list so in-flight transactions keep settling. In
   Render's dashboard (Environment → Environment Variables / Secret Files), set
   both in the same edit and deploy:
   ```
   FEE_PAYER_SECRET_KEY = <contents of /tmp/fee-payer-new.json>
   FEE_PAYER_LEGACY_SECRET_KEYS = <contents of /tmp/fee-payer-old.json>
   ```
   Updating both in one edit means one deploy and no window where only one key
   is loaded. Render creates a new deploy when the environment changes, so both
   `api` and `worker` services pick it up.

4. **Announce the new fee-payer pubkey to clients.** Until they rebuild against
   it, new transactions still name the old key — which is fine, it is in the
   legacy list. This step ends the *inflow* of old-key transactions; step 5
   waits for the existing ones to clear.

5. **Watch the drain.** The worker logs every co-sign that used a legacy key:
   ```
   "Co-signed with a legacy fee payer — rotation still draining"
   ```
   When that stops appearing, and no queued job predates the announcement, the
   old key is no longer in use. Confirm nothing is being refused outright:
   ```sql
   SELECT count(*) FROM jobs
    WHERE failure_code = 'FEE_PAYER_MISMATCH'
      AND created_at > now() - interval '1 hour';
   ```
   Non-zero means some client is naming a key in *neither* list — investigate
   before removing anything.

6. **Retire the old key.** Only once the drain log has been quiet for longer
   than the oldest plausible queued intent. Remove `FEE_PAYER_LEGACY_SECRET_KEYS`
   from Render's environment and redeploy. Then sweep residual SOL out of the
   old account.

7. **Destroy the local copies.** `shred -u /tmp/fee-payer-*.json` (or `rm -P` on
   macOS). Do not leave them in shell history or a non-secret note.

### Procedure (suspected compromise)

Order changes — containment beats continuity, and you accept stranding
in-flight work.

1. **Cut spend first.** Sweep remaining SOL out of the compromised fee payer to
   a safe address. An attacker with the key can only spend what it holds; an
   empty fee payer signs transactions that fail for want of fees.
2. **Rotate without the legacy grace.** Set `FEE_PAYER_SECRET_KEY` to the new
   key and **do not** add the compromised key to `FEE_PAYER_LEGACY_SECRET_KEYS`
   — honouring it is exactly what you are trying to stop. Transactions naming it
   will fail with `FEE_PAYER_MISMATCH`; that is the intended trade.
3. **Check the blast radius.** The fee payer co-signs but does not authorise
   transfers — a leaked fee-payer key alone cannot move user funds, because
   `coSignAsFeePayerWithKeys` requires a valid *user* signature over the message
   before it will co-sign, and the SPL transfer itself needs the token owner's
   signature. The realistic damage is SOL drain from the fee payer and
   fee-sponsorship abuse, not user-fund theft. Re-verify that claim if the
   delegate-authority model is ever reintroduced — under delegation the fee
   payer *would* be able to move user funds.
4. **Rotate the other secrets in the same env**, since whatever exposed one env
   var probably exposed all of them: `SUPABASE_SERVICE_ROLE_KEY`,
   `DATABASE_URL`, `POLAR_*`.
5. Then work out how it leaked.

### Remaining limitations

**No automatic drain detection.** Step 5 relies on reading a log line and
judging when it has stopped. Nothing tracks "oldest queued intent naming the
legacy key", so retiring the old key too early is a judgement call rather than a
guarded operation. A query over `jobs.intent_envelope` could answer it
precisely; not built.

**Still no KMS or remote signer.** Multi-key support makes rotation safe to
perform; it does not reduce the exposure of holding raw private keys in process
memory. Both keys are equally readable by anyone with Render dashboard access
during a rotation window.

**Legacy keys are unbounded in count.** Nothing stops a mis-configuration from
loading many legacy keys, each of which remains able to sign. Keep the list to
one key, and only during an active rotation.

---

## 4. Spend policy and circuit breakers

`src/lib/spendPolicy.ts` provides two guards, wired into the broadcast path in
`src/worker/broadcast.ts` (`enforceSpendPolicy`). Both are **fail-closed**: if
the check cannot run, the broadcast is refused.

Both run **before co-signing**. Refusing after signing would leave a
fully-signed transaction we then decline to send — recoverable by anyone who
obtains the bytes, and wasted work.

### Per-intent amount ceiling

Per-asset maximum, in the mint's base units, configured in
`src/lib/spendCeilings.ts`.

| Asset | Ceiling | Base units |
|---|---|---|
| USDC (6 dp) | $100 | `100_000_000` |
| SOL (9 dp) | 1.2 SOL | `1_200_000_000` |

**Provisional.** Both were set before any real transaction volume existed to
calibrate against — the 77 historical jobs are all development traffic. There is
a dated `TODO(2026-08-02)` in `spendCeilings.ts` to re-derive them from observed
p99 once metering collects real data. It exists so "provisional" does not become
permanent by default.

Values are declared through `baseUnits(whole, decimals, actual)`, which
validates the arithmetic at author time using string maths — `1.2 * 10**9` is
`1200000000.0000002` in IEEE 754, and a ceiling entered in whole units where
base units were meant is 10^decimals too permissive. A new asset cannot be added
without stating all three and having them agree.

An asset with **no configured ceiling is refused** (`NO_CEILING_CONFIGURED`) — a
missing ceiling is a config gap, not permission for an unbounded payment.

A bare SPL `Transfer` does not carry the mint as an instruction operand, so the
asset cannot always be determined from the transaction alone; that case is also
refused (`TRANSACTION_NOT_VALUABLE`). `TransferChecked` does carry the mint.

**Adding an asset to the relayer without adding its ceiling stops every payment
in that asset.** Deliberate — for a component that spends money, silence should
mean "no".

### Fee-payer velocity

Rolling window over both total value and transaction count, so a thousand small
payments trip it even though no single one approaches the per-intent ceiling.
Backed by `RedisVelocityStore` over the Redis already present for BullMQ.

**Redis, not memory, is load-bearing here.** Render's free tier suspends
services during idle periods and restarts on deploy and scale, and an in-memory
window is cleared by every one of those — forgetting real spend in ordinary
operation and making the breaker resettable by anyone who can trigger a restart.

Current window (`VELOCITY_WINDOW` in `src/worker/broadcast.ts`). **Both scopes are
enforced on every broadcast:**

| Cap | Global | Per team |
|---|---|---|
| USDC per hour | `2_000_000_000` (2,000 USDC, 6dp) | `500_000_000` (500 USDC) |
| SOL per hour | `24_000_000_000` (24 SOL, 9dp) | `6_000_000_000` (6 SOL) |
| Transactions per hour | 40 | 10 |

**Per-team scoping is load-bearing, not a refinement.** The window was previously
global only, keyed on one Redis entry across every tenant. That made the count cap
a shared budget: one team submitting 40 payments in an hour halted broadcasts for
*every other team*. With one tenant that is invisible; with ten it is a
tenant-isolation failure of the same shape as a cross-tenant data leak, except
what leaks is availability rather than data.

Each team now has its own window (`zrn:fee-payer:velocity:team:<teamId>`) and the
global aggregate is retained alongside it (`zrn:fee-payer:velocity:global`).
Neither subsumes the other:

- **Global** catches a compromised fee-payer key, and many teams collectively
  draining the shared pool while each stays inside its own allowance.
- **Per-team** stops one tenant consuming the platform's whole budget.

Global is checked **first**, so a platform-wide condition is reported as such
rather than blamed on whichever tenant happened to arrive at the wrong moment.
Breach codes distinguish the scope — `FEE_PAYER_VALUE_LIMIT` / `FEE_PAYER_COUNT_LIMIT`
for global, `TEAM_VALUE_LIMIT` / `TEAM_COUNT_LIMIT` for per-team — and a team
breach names the team in the message, so an alert says who to look at.

Per-team is set at 1/4 of global, so no single tenant consumes more than a quarter
of platform capacity and four busy tenants can coexist. That ratio is a judgement
about fair sharing, not a measurement.

**Each asset is tracked and capped independently.** An earlier version compared a
single number against whatever asset was moving, so `500_000_000` meant both
"500 USDC" and "0.5 SOL" at once — incoherent as soon as more than one asset
flows. Base units are not commensurable across mints, so there is no correct
single figure; each mint carries its own cap, and an asset with no configured cap
is refused rather than defaulted.

The **count** cap is deliberately shared across assets within each scope, so
splitting volume across mints cannot evade it.

**These figures remain provisional** — see [Calibrating the caps](#calibrating-the-caps-once-traffic-exists).

#### Known limitation: check-then-record is not atomic

`checkFeePayerVelocity` reads the window, decides, then records. Two workers can
both read a just-under-threshold window and both proceed, so the cap can be
exceeded by up to `BULL_CONCURRENCY` transactions at the boundary.

Accepted deliberately: the breaker exists to catch a compromised key or a
runaway loop, where the overshoot is orders of magnitude past the limit and a
few transactions of slack changes nothing. Closing it needs a Lua script doing
check-and-record in one round trip — worth doing if the caps are ever tightened
to where boundary accuracy matters.

### Rolling SOL budget

The guard that makes **open token support** defensible. A value ceiling requires
knowing what a token is worth, which needs a price oracle this system does not
have — so for any mint without an explicit ceiling, the only bound that means
anything is what the *relayer itself* spends: signature fees plus ATA rent.

This shifts what is being protected, and that is worth stating plainly. For USDC
and SOL, the value ceilings protect the **user** from an oversized payment. For
an unlisted mint, this budget protects **Zypp** from fee drain. Only the second
is expressible without an oracle, so "the relayer refuses oversized payments" is
true only for the two assets with real ceilings.

Caps (`DEFAULT_SOL_BUDGET_CONFIG` in `src/lib/solBudget.ts`):

| Cap | Value |
|---|---|
| Global, per hour | `1_000_000_000` lamports (1 SOL) |
| Per team, per hour | `20_000_000` lamports (0.02 SOL) |

**Both are enforced, and neither subsumes the other.** Without the global cap, N
teams each spending a full per-team allowance drain N x the intended maximum from
one shared fee payer. Without the per-team cap, one compromised key consumes the
whole global budget and starves every honest team. Global is checked **first**, so
a platform-wide condition is reported as such rather than blamed on whichever
tenant happened to arrive when the pool ran dry.

ATA rent (~0.00204 SOL) dominates — roughly 200x a signature fee — so the
realistic drain is someone minting a worthless token and spraying dust at fresh
recipients.

#### Why per-team is 0.02 SOL and not 0.1

The per-team cap has to bind somewhere near where the per-team velocity count cap
binds, or one of the two guards is decorative. Worst case per transaction is
~2,049,280 lamports (ATA rent + two signatures), so:

| Per-team cap | Transactions to trip it | vs velocity (10/hour) |
|---|---|---|
| 0.1 SOL (original) | ~49 | never binds — velocity fires 5x sooner |
| **0.02 SOL (current)** | **~10** | **both bind together** |

At 0.1 SOL the SOL budget could not fire before velocity did, in any scenario. For
repeat recipients (~10,000 lamports, no ATA rent) it would have needed ~10,000
transactions against a 10/hour count cap — unreachable by a factor of 1,000. It
was dead code that read as defence in depth.

There is a test asserting the two caps stay within 2x of each other
(`solBudget.test.ts`), so tightening velocity without revisiting this — or vice
versa — fails loudly rather than silently reintroducing an inert guard.

**Still provisional.** These figures were chosen for the *shape* of the
constraint, not from measured behaviour — no traffic exists to calibrate against.
See [Calibrating the caps](#calibrating-the-caps-once-traffic-exists).

#### Enforced at two points

| | Ingress (`POST /v1/intents`) | Worker (broadcast) |
|---|---|---|
| Function | `checkSolBudgetAvailable` | `reserveSolSpend` |
| Effect | read-only | reserves atomically |
| On breach | `429` + `Retry-After` | defers the job |
| Authoritative | no | **yes** |

The ingress check is a **fast refusal, not an admission guarantee**. Passing it
does not promise the worker's reservation succeeds — other traffic can consume
the remaining budget in between, and the job is then deferred, which is the
outcome it would have had anyway. What it reliably catches is a window *already*
over the ceiling, where returning `202` would hand the client a job that cannot
progress and a status that will not change.

It is deliberately read-only. Reserving at both points would double-count every
transaction, filling the window at twice the real rate and halving the effective
cap.

Both read the caps from one exported constant. Two copies would drift, and the
failure would be silent: the API accepting work the worker then refuses.

**The shunt path is not gated.** A degraded/shunted transaction is broadcast by
the sender's own wallet through the public RPC and spends none of the relayer's
SOL, so refusing it on the fee payer's budget would block work that costs the fee
payer nothing.

#### A budget trip is a deferral, not a failure

This is the only policy refusal in the system that is **retriable**. Every other
one — ceiling breach, velocity breach, malformed transaction — is permanent,
because the transaction itself is defective. Here the transaction is fine and the
relayer is temporarily out of budget, so the same bytes will settle once the
window rolls.

The worker calls `job.moveToDelayed(...)` and throws `DelayedError`, which
reschedules **without consuming a retry attempt**. Treating it as an ordinary
retriable error would burn `BULL_MAX_ATTEMPTS` well inside the hour and discard
legitimate work. The two calls must be used together — moving without throwing
lets the worker fall through and complete the job.

`SOL_BUDGET_DEFERRAL_CODES` is the single source of truth for which codes defer.

#### Reservations are pessimistic, then reconciled

Cost is not knowable before broadcast: priority fees vary and ATA rent is only
owed if the account does not already exist. So the **worst case** is reserved up
front (two signatures + ATA creation) and reconciled down once the real cost is
known.

Over-reserving fails safe. Under-reserving would let concurrent workers each see
room that is not there and collectively breach the cap — check-then-act, except
the resource is money. Reconciliation and release deliberately never throw: a
transaction that already landed must not be reported as failed because a
bookkeeping write did not stick. A failed reconcile leaves the worst-case figure
held, which over-counts spend and is therefore the safe direction.

#### Client handling

A `429` from this path carries `Retry-After` in seconds, and the same value as
`retryAfter` in the body. The figure is **approximate**: it reports when the
*oldest* window entry expires, which is the soonest any budget frees — not a
guarantee that enough frees. A client may retry once and be refused again.

Batch submissions are multi-status, so each item carries its own `retryAfter` in
its body; the response header carries the **longest** across the batch, since a
shorter value would tell the client to retry while some items are still certain
to be refused.

`ATA_RENT_LAMPORTS` is hardcoded at `2_039_280` rather than fetched, so the
decision to use the network does not depend on the network being healthy. **If
Solana's rent parameters ever change this becomes an under-estimate and the
budget under-reserves** — that is the failure direction to watch, and it is not
currently automated.

### Calibrating the caps once traffic exists

Every threshold in this section — per-intent ceilings, velocity caps, SOL budget
— is **provisional**. They were chosen for the shape of the constraint, not
derived from behaviour, because at the time of writing the platform had no users.
That is an honest starting position, but it stops being honest the moment real
traffic exists and nobody revisits it.

This section says exactly what to measure so the next pass is a calculation
rather than another guess.

#### Precondition: do not calibrate against nothing

Wait for **at least two weeks of traffic from three or more distinct teams**,
including at least one day that felt busy. Fewer teams and the per-team
distribution is one tenant's habits, not a distribution. Less time and a single
launch spike sets the ceiling for everything after.

Until then, leave the numbers alone. A guess re-derived from insufficient data is
worse than the original guess, because it arrives wearing evidence.

#### What to measure

All of it comes from the `jobs` table; no new instrumentation is needed.

| Quantity | Query | Sets |
|---|---|---|
| Per-intent value, p99 by asset | `intent_total` percentile grouped by `intent_currency`, confirmed jobs only | `DEFAULT_AMOUNT_CEILINGS` |
| Per-team hourly value, p99 by asset | sum `intent_total` per `(team_id, date_trunc('hour', created_at), intent_currency)`, then p99 | `VELOCITY_WINDOW.perTeam.maxValuePerAsset` |
| Per-team hourly count, p99 | count per `(team_id, hour)`, then p99 | `VELOCITY_WINDOW.perTeam.maxCountPerWindow` |
| Platform hourly count, p99 | count per hour across all teams | `VELOCITY_WINDOW.global.maxCountPerWindow` |
| ATA creation rate | fraction of confirmed payments whose transaction created an ATA | the assumption behind the SOL budget |

The last one is the load-bearing measurement and the one most likely to be
skipped. The entire SOL budget is sized on the assumption that ATA creation is
common enough to dominate cost. If it turns out to be rare — most payments going
to recipients who already hold the token — then real spend is ~200x lower than
the worst case being reserved, the budget is over-reserving massively, and the
per-team cap should move accordingly.

#### How to turn measurements into caps

**Ceilings and velocity: p99 x 3.** These are backstops meant to catch compromise
and runaway loops, not to shape normal traffic. A cap at p99 would refuse
legitimate work roughly once per hundred requests. Three times p99 leaves room
for growth between calibration passes while still catching an order-of-magnitude
anomaly.

**SOL budget: from what you can afford to lose, not from traffic.** This one is
different in kind. It bounds loss during an incident, so the input is a business
decision — *how much SOL can drain in an hour before someone must be woken up* —
not a percentile. Measured traffic only tells you whether that figure is
comfortably above normal usage. If it is not, the constraint is the fee payer's
funding, not the cap.

**Then re-check the relationship.** Per-team SOL budget and per-team velocity
count must still bind at similar volumes, or one becomes decorative — see
[Why per-team is 0.02 SOL](#why-per-team-is-002-sol-and-not-01). The test in
`solBudget.test.ts` enforces a 2x tolerance and will fail if a calibration pass
moves one without the other.

#### Where the numbers live

| File | Constant |
|---|---|
| `src/lib/spendCeilings.ts` | `DEFAULT_AMOUNT_CEILINGS` |
| `src/worker/broadcast.ts` | `VELOCITY_WINDOW` (`.global` and `.perTeam`) |
| `src/lib/solBudget.ts` | `DEFAULT_SOL_BUDGET_CONFIG` |

Each carries a `TODO(2026-08-02)` pointing here. **Revisit them together** — the
20x ceiling-to-velocity ratio and the 1/4 global-to-per-team ratio are
assumptions about how the guards relate, and changing one in isolation quietly
breaks the relationship the others were chosen against.

### Alerting destination — Telegram

Alerts go to the **`zypp_ceiling_alert_bot`** bot, posting into the **"Zypp
Ceiling Alert"** channel/group. Wired in `src/lib/alerting.ts`; a tripped
breaker calls `AlertNotifier.notify()` with the same context that is structured-
logged (intent id, team id, amount, threshold, asset).

#### The two values, and why both are needed

The bot token identifies the *sender*. Telegram's `sendMessage` also needs a
`chat_id` identifying the *destination* — the bot cannot infer where to post
from its own identity, so both are required.

| Variable | What it is | Where it comes from |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot's API token | @BotFather → `/mybots` → `zypp_ceiling_alert_bot` → API Token |
| `TELEGRAM_ALERT_CHAT_ID` | The destination chat's **numeric** id | `getUpdates`, after a human has messaged the bot — see below |

**If the token is ever pasted anywhere it should not be** (a chat, a ticket, a
commit), revoke it immediately: @BotFather → `/mybots` → the bot → API Token →
Revoke current token, then update Render. A leaked bot token lets anyone post as
the alert bot, which means anyone can forge or drown out breaker alerts.

There is no fixed or well-known value for the chat id — it is whatever
identifies your destination, and **you cannot construct it by hand**.

**A bot cannot open a conversation.** Telegram blocks bots from messaging anyone
who has not messaged them first, as anti-spam. So a personal @username is *never*
a valid `chat_id` — `@yourname` returns "chat not found" every time, regardless
of configuration. The chat has to be created from the human side first.

- **Private chat with a person (simplest):** open the bot in Telegram, press
  **Start**, send any message. That creates the chat. The id is a **positive**
  integer.
- **Group:** create the group, add the bot, send any message in it. The id is
  **negative** (often `-100…`).
- **Channel:** add the bot as an **administrator** — plain membership is not
  enough for a channel, it cannot post otherwise.

Then read the id back:

```
bash scripts/tg-check.sh
```

This verifies the token via `getMe` and lists every chat id `getUpdates` can see,
without printing the token. (By hand:
`curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` and look for
`"chat":{"id":…}`.) An empty result means the message never registered — send
another and retry. Note `getUpdates` only returns messages sent *after* the
current token was issued, so a rotation resets what you can see.

**If two ids appear for one group, take the supergroup.** Telegram silently
migrates a `group` to a `supergroup` when it gains an admin, a public link, or
enough members — promoting the bot is enough to trigger it. Both ids then show up
in `getUpdates`, the dead one usually first, with nothing marking which is
current:

```
chat id: -5320098373      type: group        name: Zypp Ceiling Alert
chat id: -1004214324839   type: supergroup   name: Zypp Ceiling Alert
```

The `group` id is dead. Sending to it returns
`400 Bad Request: group chat was upgraded to a supergroup chat`. Use the
`supergroup` id (the `-100…` form). This is worth checking again after any change
to group membership or permissions, since a later migration would strand the
configured id the same way.

Only a *public channel's* @username works as a `chat_id`. For everything else it
is the numeric id.

**An invite link is not a chat id.** A private group's invite link
(`https://t.me/+70fxrMpzob9jZThk`) carries an invite *hash*, which is
deliberately unrelated to the group's numeric id — that unlinkability is a
privacy property of private groups, not an oversight. No Bot API method converts
one into the other, so the link cannot be used as `TELEGRAM_ALERT_CHAT_ID` and
cannot be turned into one. `getUpdates` after posting in the group is the only
route to the id.

A group is the better destination for a team: alerts reach everyone, and
membership changes without touching config. Making the bot an **admin** is not
required for a group (plain membership is enough to post), but it is harmless and
it does sidestep privacy mode, which otherwise hides most group messages from the
bot and can leave `getUpdates` looking empty. Be aware it also triggers the
supergroup migration above.

#### Install the secrets

Local development, in `.env` (gitignored — verify with
`git check-ignore -v .env`):

```
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALERT_CHAT_ID=<@channelusername or -100…>
```

Production, in Render's dashboard (Environment → Environment Variables):

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ALERT_CHAT_ID=<@channelusername or numeric id>
```

Single-quoting is unnecessary in the dashboard — paste the value verbatim.
Render creates a new deploy when the environment changes, so `api` and `worker`
both pick it up. A value stored in **Secret Files** rather than as an env var is
marginally safer against it appearing in logs.

#### Verify delivery before trusting it

Config being present is not evidence that messages arrive. Send one by hand:

```
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d chat_id='<CHAT_ID>' -d text='zypp breaker test'
```

If that does not land in the channel, the relayer's alerts will not either.
Given that metering already ran dark for weeks unnoticed (B2 in
`to-be-fixed.md`), an unverified alert path is the same failure mode somewhere
it matters more.

#### Degradation is quiet by design — know the signal

If either variable is missing, `createAlertNotifier` returns
`LoggingOnlyNotifier`: breaker trips are logged at `error` and **nobody is
paged**. The only signal is one startup line:

```
Telegram alerting not configured — circuit breaker trips will only be logged
```

Delivery failures are also logged and swallowed rather than thrown — the
breaker has already refused the transaction, and turning a notification problem
into a second error on top of the refusal would be worse. The consequence is
that a broken alert path is invisible unless you look for it, which is why the
manual `curl` above matters.

Regardless of alerting, `stage: "PolicyCheck"` in the failure data is the
durable record:

```sql
SELECT failure_code, count(*), max(created_at)
  FROM jobs WHERE failure_stage = 'PolicyCheck'
 GROUP BY failure_code ORDER BY 3 DESC;
```

---

## 5. Migration and schema

Render has a **Pre-Deploy** command hook for this: set it to
`node dist/store/run-migrate.js` so migrations run before each deploy's new
service starts. This needs to be verified in the Render dashboard — there is no
`render.yaml` in the repo, so it is not confirmed that this is configured.

**Worth knowing:** migrations are not the schema's only source of truth. Some
were applied by hand through the Supabase SQL editor during the audit (see
`to-be-fixed.md` issues 1–5), and migration 005 was initially skipped then
applied out of sequence. The migration runner also re-executes every `.sql` file
on each run with no tracking table (issue 4), so it is safe today only because
every migration happens to be idempotent.

**This is currently broken for anyone without the full relayer env.**
`run-migrate.ts` calls `loadConfig()`, which validates the entire schema
including `FEE_PAYER_SECRET_KEY` and `RPC_URLS` — neither of which a migration
needs. In Render's environment the secrets are present so a Pre-Deploy hook
works, but it fails locally and in any CI without production secrets. Tracked as
issue 3 in `to-be-fixed.md`.

The first backfill `UPDATE` anyone writes will re-run on every deploy, because of
the missing tracking table noted above.
