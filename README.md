# PharmaChain

Role-based pharmaceutical supply-chain integrity on the **Ethereum Sepolia
testnet**: whitelisted participants, hash-anchored QC certificates, a full
custody timeline, automatic cold-chain breach detection (too warm *or*
frozen), regulator recall, and a free public verification page.

Built for a class blockchain project (team of 4).

---

## 1. Problem and solution

About 1 in 10 medical products in low- and middle-income countries is
substandard or falsified (WHO). Certificates can be forged, custody logs sit
in each company's private database, and a vaccine that got too warm looks
identical to a good one. Every party has to trust the last company in the
chain, and none can independently check.

PharmaChain puts only the **facts that matter for trust** on a public ledger:

| On-chain (PharmaChain.sol) | Off-chain (unchanged) |
|---|---|
| Role registry: who may register, certify, move batches | Company identity checks (KYC) |
| Batch ID, manufacturer, QC certificate **hash**, safe temp range | The actual QC certificate PDF |
| Certification status (regulator-signed) | Regulator's internal review |
| Every custody hop with timestamp | Physical logistics |
| Every temperature reading + automatic breach flag | The physical IoT sensor |

### Why blockchain, not a shared database

- **No single party is trusted.** Manufacturer, regulator, distributor and
  pharmacy are mutually distrusting. A shared database needs an operator who
  could quietly edit history or override rules. A mined transaction cannot be
  rewritten.
- **Access control is enforced by code.** Only wallets the regulator
  whitelisted can act; only the regulator can certify or recall. No database
  admin can override that.
- **The audit trail is the product.** "Did this batch ever leave its safe
  range, and who held it?" is exactly what a ledger is for.
- **Privacy:** only a hash of the certificate goes on-chain.

## 2. What is in v2

| Feature | Where |
|---|---|
| Role registry (manufacturer / distributor / pharmacy), set by the regulator | `setRole` |
| Many batches at once | `registerBatch`, `getAllBatchIds` |
| Custody history per batch, only to authorised recipients | `transferCustody`, `getCustodyHistory` |
| Temperature log, breach if above max **or** below min | `logTemperature`, `getTemperatureLog` |
| Delivered status when a batch reaches a pharmacy | `transferCustody` |
| Regulator recall | `recallBatch` |
| Public verification (GENUINE / BREACHED / RECALLED / UNCERTIFIED / UNKNOWN) | `/verify` page |
| Attack simulator (5 attacks, all refused by the contract) | dashboard |
| Live ledger with Etherscan links, analytics, temperature chart | dashboard |

## 3. What is real vs simulated

Say this out loud in the presentation (slide 12 and the demo slide state it).

- **Real:** the Solidity contract, its deployment, and every register,
  certify, transfer, log, recall and role transaction, mined on the public
  Sepolia testnet and visible on Etherscan. Attacks are rejected by the
  contract itself (the server only reports the reason).
- **Simulated:** temperature readings are typed in (stand-in for an IoT
  sensor); the QC certificate is represented only by its hash; the five wallets
  (regulator, manufacturer, distributor, pharmacy, counterfeiter) stand in for
  real KYC'd organisations. The server derives the four extra wallets from your
  key and tops them up with a little test ETH.
- **For production:** connect `logTemperature` to real IoT data through an
  oracle, store certificates off-chain (e.g. IPFS) with the hash on-chain,
  integrate with GS1 / DSCSA / FMD serialization, and replace the single
  regulator wallet with a multi-signature or governed role.

## 4. Files

```
PharmaChain.sol        smart contract (Solidity 0.8.24)
compile.js             compiles the contract to compiled.json
server.js              Express + ethers.js: deploys, signs transactions, REST API
public/index.html      dashboard (control room)
public/verify.html     public verification page
package.json           dependencies
.env                   YOUR PRIVATE KEY (never commit; listed in .gitignore)
```

## 5. Setup (MacBook, VS Code bash terminal)

1. Open the project folder in VS Code (**File > Open Folder**) and open the
   terminal (`` Ctrl+` ``).
2. Install packages: `npm install express ethers dotenv solc`
3. Make sure the folder contains `public/index.html` and `public/verify.html`.
4. Create `.env` with:
   ```
   PRIVATE_KEY=0xyourSepoliaKey
   PORT=3000
   ```
   Use a wallet with no real money. It becomes the **regulator** wallet and
   pays for deployment and for topping up the other wallets, so give it at
   least **0.02 Sepolia ETH** (Google Cloud faucet:
   https://cloud.google.com/application/web3/faucet/ethereum/sepolia).
5. Run: `node server.js` (it compiles automatically if `compiled.json` is
   missing).
6. Open http://localhost:3000. The public page is at http://localhost:3000/verify.

Optional: after the first run, add `CONTRACT_ADDRESS=0x...` (printed at
startup) to `.env` to re-use the same contract and keep your batches between
restarts. Leave it out for a fresh contract.

## 6. Live demo script (about 4 minutes)

1. **Onboard participants** (banner at the top): the regulator wallet
   whitelists the manufacturer, distributor and pharmacy on-chain.
   Then register a batch: lot **B-001** (the lot name used in the slides),
   any product name, safe range 2 to 8 C, click **Register batch**.
2. Select the batch, **Certify (regulator)**. Only the regulator can.
3. **Hand to distributor**, then **Normal 5.0 C**. Custody and readings are
   now a timeline anyone can read.
4. **Attack simulator**: click *Counterfeiter forges a certification* and
   *Counterfeiter steals custody*. The contract refuses; the ledger shows
   the reason and the counter increments. Nothing was sent or paid for.
5. **Too warm 9.5 C**: the contract locks the batch on its own. Click
   *Open public verification* to show the pharmacist's view
   (COLD CHAIN BROKEN). Type a made-up lot on the verify page to show
   UNKNOWN, which is how a counterfeit appears.

Each Sepolia transaction takes roughly 10 to 20 seconds. Talk through the
business point while it confirms, and click a transaction link to show it on
Etherscan.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid private key` | `.env` key must start with `0x`, no spaces or quotes |
| `insufficient funds` | Fund the regulator wallet; it pays for everything |
| Page loads but is unstyled | The Tailwind CDN needs internet; check Wi-Fi |
| `Cannot find module` | Run `npm install express ethers dotenv solc` in the project folder |
| Port in use | Change `PORT` in `.env` |

## 8. Pushing to GitHub

```bash
git init
git status            # .env and node_modules must NOT be listed
git add .
git commit -m "PharmaChain v2"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/pharmachain.git
git push -u origin main
```

## 9. How this maps to the assignment brief

| Brief requirement | Where |
|---|---|
| Business model: users, revenue, team, role of blockchain, USPs | Slides 2, 6, 10, 11 |
| Solidity prototype with operational features | `PharmaChain.sol` + dashboard |
| Rigorous testing and refinement | `TESTING.md`, `test/e2e.js` |
| Development process and AI use | Slide 12 |
| Live demo, 10 to 15 minute talk | Slide 13 |
| One zip with presentation and all files | see checklist below |

## 10. Submission checklist

AI chat used to build the code (also on slide 12): https://claude.ai/chat/6255442e-5495-462f-9ea4-37234aef495f
