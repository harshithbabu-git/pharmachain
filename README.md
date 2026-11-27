# PharmaChain

**Role-based pharmaceutical supply-chain integrity on Ethereum.**

PharmaChain records who made a batch of medicine, who certified it, who has held it, and whether it ever left its safe temperature range, on a public blockchain where no single company can quietly edit history. It is a working prototype: a Solidity smart contract, a Node.js server that signs real transactions, a web dashboard to operate the chain, and a public page where anyone can verify a batch.

It runs on the **Ethereum Sepolia test network**, so it is free to try and no real money is involved.

> Built as a university blockchain project (Fall Term 2026). It is a prototype for learning and demonstration, not production software.

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Features](#features)
- [Quick start](#quick-start)
- [Using the dashboard](#using-the-dashboard)
- [The public verification page](#the-public-verification-page)
- [Smart contract reference](#smart-contract-reference)
- [REST API](#rest-api)
- [Testing](#testing)
- [Project structure](#project-structure)
- [What is real and what is simulated](#what-is-real-and-what-is-simulated)
- [Limitations and next steps](#limitations-and-next-steps)
- [Troubleshooting](#troubleshooting)

---

## The problem

Roughly 1 in 10 medical products in low- and middle-income countries is substandard or falsified (WHO). Three weaknesses make this hard to stop:

1. **Certificates can be forged.** A pharmacy often has no original to compare against.
2. **Custody records are siloed.** Every company keeps its own log, so the full journey of a batch is hard to verify.
3. **Temperature damage is invisible.** A vaccine that got too warm or froze looks identical to a good one.

Underneath all three is a trust problem: every party has to trust the last company in the chain, and none of them can independently check.

## How it works

PharmaChain puts only the facts that matter for trust on a public ledger, and keeps everything else off-chain.

| On-chain (`PharmaChain.sol`) | Off-chain (not stored) |
|---|---|
| Role registry: who may register, certify and move batches | Company identity checks (KYC) |
| Batch ID, manufacturer, QC certificate **hash**, safe temperature range | The QC certificate document itself |
| Certification status, signed by the regulator | The regulator's internal review |
| Every custody hand-over with a timestamp | Physical logistics |
| Every temperature reading and an automatic breach flag | The physical sensor |

### The lifecycle of a batch

```
 Regulator whitelists roles
          │
 Manufacturer registers batch (certificate hash + safe range)   → AwaitingCertification
          │
 Regulator certifies it                                         → Certified
          │
 Holder hands it on: manufacturer → distributor → pharmacy      (each hop recorded)
          │            temperature readings logged along the way
          │
          ├─ reading outside the safe range ──────────────────→ ColdChainBreached (locked)
          ├─ regulator recalls it ────────────────────────────→ Recalled
          └─ reaches a registered pharmacy ───────────────────→ Delivered
```

### Why a blockchain and not a shared database?

- **No single party is trusted.** Manufacturer, regulator, distributor and pharmacy do not trust each other. A shared database needs an operator who could edit history or override rules. A mined transaction cannot be rewritten.
- **Access rules are enforced by code.** Only whitelisted wallets can act, and only the regulator can certify or recall. No database administrator can bypass that.
- **The audit trail is the product.** "Did this batch ever leave its safe range, and who held it?" is exactly what a ledger answers.
- **Privacy by design.** Only a hash of the certificate goes on-chain, never the document.

## Features

- **Role registry.** The regulator whitelists manufacturers, distributors and pharmacies. Everyone else is refused.
- **Many batches at once**, each with a hash-anchored quality certificate.
- **Custody history.** Batches can only move to authorised recipients, and only the current holder can move them.
- **Automatic cold-chain protection.** A reading above the maximum **or below the minimum** flags the batch as breached and blocks further transfers.
- **Regulator recall.**
- **Public verification page** with five verdicts: `GENUINE`, `NOT YET CERTIFIED`, `COLD CHAIN BROKEN`, `RECALLED` and `UNKNOWN` (a batch the chain has never seen, which is how a counterfeit appears).
- **Attack simulator.** One-click attacks (forged certification, stolen custody, self-granted role, overwriting a batch, unauthorised registration) that the **contract itself** rejects, with the revert reason shown.
- **Live ledger** of every transaction with Etherscan links, a temperature chart and analytics.

## Quick start

### Prerequisites

- **Node.js 18 or newer** (`node -v` to check)
- A wallet with **Sepolia test ETH**. Use a throwaway wallet that holds no real funds. Get free test ETH from a faucet, for example the [Google Cloud Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia). About **0.02 Sepolia ETH** is plenty.

### Install

```bash
git clone https://github.com/harshithbabu-git/pharmachain.git
cd pharmachain
npm install
```

### Configure

Create a file named `.env` in the project folder:

```
PRIVATE_KEY=0xyour_sepolia_test_wallet_private_key
PORT=3000
```

| Variable | Required | Meaning |
|---|---|---|
| `PRIVATE_KEY` | yes | The **regulator** wallet. It deploys the contract and tops up the other demo wallets with gas. Must start with `0x`, no quotes or spaces. |
| `PORT` | no | Dashboard port. Default `3000`. |
| `RPC_URL` | no | Sepolia RPC endpoint. Default is a public node. |
| `CONTRACT_ADDRESS` | no | Re-use an already deployed contract instead of deploying a new one. |

> **Never commit `.env` or use a wallet that holds real money.** `.env` is already listed in `.gitignore`.

### Run

```bash
node server.js
```

The server compiles the contract if needed, deploys it to Sepolia (about 20 to 30 seconds), funds the demo wallets, and prints:

```
Dashboard:          http://localhost:3000
Public verify page: http://localhost:3000/verify
```

Open the dashboard in your browser. Every start deploys a **fresh, empty contract** unless you set `CONTRACT_ADDRESS` (the address is printed at startup, with a tip on how to re-use it).

## Using the dashboard

The server derives five wallets from your key: **regulator** (your key), **manufacturer**, **distributor**, **pharmacy**, and a **counterfeiter** who is never given a role. The dashboard acts as each of them, and every action is a real Sepolia transaction. Each takes roughly 10 to 20 seconds to confirm.

A walkthrough that shows everything:

1. **Onboard participants** (orange banner). The regulator whitelists the manufacturer, distributor and pharmacy on-chain.
2. **Register a batch.** Enter a lot (for example `B-001`), a product name, and a safe range such as 2 to 8 °C, then click *Register batch*.
3. **Certify** the selected batch. Only the regulator can.
4. **Hand to distributor**, then log **Normal 5.0 °C**. The custody timeline and temperature chart update.
5. **Attack simulator.** Click *Counterfeiter forges a certification* and *Counterfeiter steals custody*. The contract refuses both and the ledger shows the reason.
6. Log **Too warm 9.5 °C** (or **Too cold -1.0 °C**). The contract locks the batch by itself and it can no longer be moved.
7. Click *Open public verification* to see what a pharmacist would see: **COLD CHAIN BROKEN**.

## The public verification page

`http://localhost:3000/verify` is a read-only page for pharmacists, auditors and patients. It needs no wallet and no login. Enter a lot in the form `LOT | Product` (for example `B-001 | Rotavirus Vaccine`), exactly as the manufacturer registered it, or a raw batch ID (`0x…`).

It shows the verdict, the certificate hash, the custody chain, the temperature log against the safe range, and a link to the contract on Etherscan. A batch the chain has never seen is reported as **UNKNOWN, likely counterfeit**.

## Smart contract reference

`PharmaChain.sol` (Solidity 0.8.24). Temperatures are stored as **tenths of a degree Celsius** (`20` = 2.0 °C).

**Statuses:** `Unregistered`, `AwaitingCertification`, `Certified`, `ColdChainBreached`, `Recalled`, `Delivered`.

| Function | Who can call | What it does |
|---|---|---|
| `setRole(account, role)` | Regulator | Whitelists an account as `Manufacturer`, `Distributor` or `Pharmacy` |
| `registerBatch(batchId, label, qcCertHash, minSafeTemp, maxSafeTemp)` | Manufacturer | Registers a batch with its certificate hash and safe range |
| `certifyBatch(batchId)` | Regulator | Certifies a registered batch |
| `transferCustody(batchId, newHolder)` | Current holder | Hands a certified batch to a distributor or pharmacy. A pharmacy recipient marks it `Delivered` |
| `logTemperature(batchId, reading)` | Current holder or regulator | Records a reading. Outside the safe range flips the batch to `ColdChainBreached` |
| `recallBatch(batchId, reason)` | Regulator | Recalls a batch |
| `getBatch`, `getCustodyHistory`, `getTemperatureLog`, `getAllBatchIds`, `getBatchCount` | Anyone | Read-only views |

Events emitted: `RoleSet`, `BatchRegistered`, `BatchCertified`, `CustodyTransferred`, `TemperatureLogged`, `ColdChainBreach`, `BatchDelivered`, `BatchRecalled`.

The batch ID is `keccak256("<lot> | <product>")`.

## REST API

The server exposes the following endpoints for the dashboard. They sign transactions with the demo wallets, so run it locally only and do not expose it to the internet.

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Network, contract, wallets and batch list |
| `GET /api/logs`, `GET /api/logs/stream` | Ledger history, and a live Server-Sent Events stream |
| `POST /api/onboard` | Whitelist manufacturer, distributor and pharmacy |
| `POST /api/batches` | Register a batch: `{ product, lot, minTemp, maxTemp }` |
| `GET /api/batches/:id` | Batch detail, custody and temperature log |
| `POST /api/batches/:id/certify` | Certify |
| `POST /api/batches/:id/transfer` | Hand over: `{ to }` |
| `POST /api/batches/:id/temperature` | Log a reading: `{ reading }` |
| `POST /api/batches/:id/recall` | Recall: `{ reason }` |
| `POST /api/attack` | Run an attack: `{ type: register | certify | steal | grant | overwrite }` |
| `GET /api/verify?q=` | Public, read-only batch verification |

## Testing

`test/e2e.js` is an end-to-end scenario with 35 checks against the running server. It covers: actions before onboarding being refused, duplicate registration, transfer before certification, all five attacks, double certification, a normal run through manufacturer, distributor and pharmacy, delivery, breaches for both too-warm and too-cold readings, recall, the public verdicts, analytics and page serving.

Start the server on a **fresh contract** (leave `CONTRACT_ADDRESS` out of `.env`), then in a second terminal:

```bash
node test/e2e.js        # set BASE=http://localhost:PORT if you changed PORT
```

See [TESTING.md](TESTING.md) for what is covered and the defects found and fixed along the way. The 35 checks were developed and run against a local test chain; on Sepolia each step takes real block time, so the run is slower.

## Project structure

```
PharmaChain.sol        the smart contract (Solidity 0.8.24)
compile.js             compiles the contract to compiled.json (generated, git-ignored)
server.js              Express + ethers.js: deploys, signs transactions, REST API
public/index.html      dashboard (control room)
public/verify.html     public verification page
test/e2e.js            35-check end-to-end test
TESTING.md             testing notes
package.json           dependencies (express, ethers, dotenv, solc)
.env                   your private key (create it yourself; never committed)
```

## What is real and what is simulated

- **Real:** the Solidity contract, its deployment, and every role, register, certify, transfer, log and recall transaction, mined on Sepolia and visible on Etherscan. Unauthorised actions are rejected by the contract itself; the server only reports the reason.
- **Simulated:** temperature readings are typed in as a stand-in for an IoT sensor. The QC certificate is represented only by its hash. The five wallets stand in for real, verified organisations.

## Limitations and next steps

- Connect `logTemperature` to real IoT sensors through an oracle.
- Store certificates off-chain (for example on IPFS) with the hash on-chain.
- Integrate with industry serialization standards (GS1, DSCSA, FMD).
- Replace the single regulator wallet with a multi-signature or governed role.
- Add real participant onboarding (KYC) and wallet-based login instead of server-held demo wallets.
- Deploy a hosted version of the verification page so anyone can check a batch from their phone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid private key` | The `.env` key must start with `0x`, with no spaces or quotes |
| `insufficient funds` | Fund the regulator wallet with Sepolia ETH; it pays for deployment and top-ups |
| `Cannot find module` | Run `npm install` in the project folder |
| Port already in use | Change `PORT` in `.env` |
| Page loads but is unstyled | The dashboard loads Tailwind from a CDN, so it needs internet access |
| Transactions feel slow | Sepolia blocks take roughly 10 to 20 seconds; this is normal |
| Test script fails right away | Start the server on a fresh contract (no `CONTRACT_ADDRESS` in `.env`) |

## License

No license has been chosen yet. Add a `LICENSE` file (for example MIT) if you want others to reuse the code.