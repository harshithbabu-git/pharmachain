# Testing PharmaChain

The brief asks for rigorous testing and refinement. We tested at three levels.

## 1. Automated backend scenario (35 checks): `test/e2e.js`

It drives the real REST API against a freshly deployed contract and checks that
the contract accepts what it should and refuses what it should.

Covered: register before onboarding is refused; onboarding three roles;
duplicate batch refused; transfer before certification refused; five attack
types (forged certification, stolen custody, self-granted role, overwriting a
batch, unauthorised registration) all refused; double certification refused;
normal reading accepted; manufacturer to distributor to pharmacy hand-over
(status becomes Delivered); delivered batch cannot move; 9.5 C and -1.0 C each
trigger a breach; breached batch cannot move or log; recall and double recall;
public verification verdicts GENUINE / BREACHED / RECALLED / UNKNOWN; analytics
counters; both pages served; rejected attempts appear in the ledger.

**Run it** (needs a contract with no roles set yet, so start the server WITHOUT
`CONTRACT_ADDRESS` in `.env`):

```bash
node server.js            # terminal 1
node test/e2e.js          # terminal 2   (BASE=http://localhost:PORT if not 3000)
```

Result when we ran it: **35/35 pass**. Honest note: those runs used a local
in-memory test chain (ganache), because Sepolia transactions take 10-20 s each.
The same server code and contract were then deployed to Sepolia for the demo.

## 2. Browser UI test

A headless-browser script clicked through the dashboard (onboard, register,
certify, hand-over, readings, attacks, recall, verify page) and checked the
on-screen results.

## 3. Defects found and fixed during testing

| Problem | Fix |
|---|---|
| Stale transaction nonce ("nonce too low") after quick consecutive actions | Explicit per-wallet nonce tracking, no provider caching |
| Rejected actions showed "missing revert data" | Dry-run (`staticCall`) before sending, parse the revert reason |
| Buttons stayed disabled after an action | Restore button state in a `finally` block |
| Attack counter lagged behind the ledger | Invalidate cached state after every attack |
| Only "too warm" counted as a breach | Breach when above max OR below min (frozen vaccines) |
