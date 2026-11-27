/**
 * ============================================================================
 *  PharmaChain - role-based pharma supply-chain integrity on Ethereum Sepolia
 * ============================================================================
 *
 *  RUN:   node server.js        (then open http://localhost:3000)
 *
 *  .env needs:
 *      PRIVATE_KEY=0x...        a wallet holding Sepolia test ETH (the REGULATOR)
 *      PORT=3000                (optional)
 *      RPC_URL=...              (optional, defaults to a public Sepolia RPC)
 *      CONTRACT_ADDRESS=0x...   (optional, re-use an already deployed contract)
 *
 *  What this server does:
 *   - Deploys PharmaChain.sol (compiled to compiled.json) from the regulator wallet.
 *   - Derives 4 more demo wallets from your key: manufacturer, distributor,
 *     pharmacy and a counterfeiter (who never gets a role). It tops up the
 *     first three with a little test ETH for gas.
 *   - Exposes a REST API the dashboard uses; every state change is a REAL
 *     transaction signed by the right actor's wallet.
 *   - /api/attack lets you show, live, that unauthorised actions are REJECTED
 *     by the contract itself (not by this server).
 *
 *  REAL vs SIMULATED:
 *   REAL:      contract, deployment, every register/certify/transfer/log/recall
 *              transaction, every hash on Etherscan, every rejection reason.
 *   SIMULATED: temperature readings are typed in (stand-in for an IoT sensor),
 *              the QC certificate is represented only by its hash, the five
 *              wallets stand in for real KYC'd organisations.
 * ============================================================================
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const express = require("express");
const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// 1. CONFIG
// ---------------------------------------------------------------------------
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PORT = process.env.PORT || 3000;
const SEPOLIA_CHAIN_ID = 11155111n;
const FUND_MIN = ethers.parseEther("0.002");    // top up an actor below this
const FUND_TARGET = ethers.parseEther("0.004"); // ...to this

if (!process.env.PRIVATE_KEY) {
  console.error("\nMissing PRIVATE_KEY in .env (a funded Sepolia wallet, starting with 0x).\n");
  process.exit(1);
}

const compiledPath = path.join(__dirname, "compiled.json");
if (!fs.existsSync(compiledPath)) {
  console.log("compiled.json not found - compiling PharmaChain.sol ...");
  execSync("node compile.js", { cwd: __dirname, stdio: "inherit" });
}
const compiled = JSON.parse(fs.readFileSync(compiledPath, "utf8"));

const STATUS = ["UNREGISTERED", "AWAITING_CERT", "CERTIFIED", "BREACHED", "RECALLED", "DELIVERED"];
const ROLE = ["NONE", "MANUFACTURER", "DISTRIBUTOR", "PHARMACY"];

let provider; // created in boot() so chain id can be detected
let chainId = 0n;
let contract = null;
let contractAddress = null;
let deployTxHash = null;
const actors = {}; // name -> ethers.Wallet

// ---------------------------------------------------------------------------
// 2. HELPERS: logging (SSE), explorer links, tx queue, error parsing
// ---------------------------------------------------------------------------
const ledger = [];
const sseClients = [];
let txCount = 0;
let rejectedCount = 0;

function pushLog(entry) {
  const record = { id: ledger.length ? ledger[ledger.length - 1].id + 1 : 1, time: new Date().toISOString(), ...entry };
  ledger.push(record);
  if (ledger.length > 400) ledger.shift();
  const payload = `data: ${JSON.stringify(record)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
  return record;
}

function explorerBase() {
  return chainId === SEPOLIA_CHAIN_ID ? "https://sepolia.etherscan.io" : "";
}
function txUrl(hash) {
  return explorerBase() ? `${explorerBase()}/tx/${hash}` : "";
}
function addrUrl(a) {
  return explorerBase() ? `${explorerBase()}/address/${a}` : "";
}

// Explicit nonce tracking per wallet. Public RPC nodes can lag by a block, which
// makes the automatic "pending" nonce stale and causes "nonce too low" errors.
const nonces = {};
async function nextNonce(actor) {
  if (nonces[actor] === undefined) nonces[actor] = await provider.getTransactionCount(actors[actor].address, "latest");
  return nonces[actor];
}
const usedNonce = (actor) => { nonces[actor] = (nonces[actor] || 0) + 1; };
const resyncNonce = (actor) => { delete nonces[actor]; };

// All writes go through one queue so nonces never collide.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function reasonOf(e) {
  if (e && e.revert && e.revert.args && e.revert.args[0]) return String(e.revert.args[0]);
  if (e && e.reason) return String(e.reason);
  const inner = e && ((e.error && e.error.message) || (e.info && e.info.error && e.info.error.message));
  if (inner) return String(inner);
  const m = String((e && (e.shortMessage || e.message)) || e);
  const q = m.match(/reverted with reason string '([^']+)'/) || m.match(/execution reverted: "([^"]+)"/);
  return q ? q[1] : m;
}

function actorNameOf(address) {
  if (!address) return null;
  const a = address.toLowerCase();
  for (const [name, w] of Object.entries(actors)) if (w.address.toLowerCase() === a) return name;
  return null;
}

const asC = (tenths) => Number(tenths) / 10;
const toTenths = (c) => Math.round(Number(c) * 10);

/** Send one contract transaction as `actor`, logging it to the live ledger. */
function sendTx(actor, method, args, description) {
  return enqueue(async () => {
    const c = contract.connect(actors[actor]);
    pushLog({ type: "info", actor, message: `${actor.toUpperCase()} -> ${description}` });
    try {
      // Preflight as a read-only call first: surfaces the contract's exact revert
      // reason and never wastes gas or a nonce on a transaction that would fail.
      await c[method].staticCall(...args);
      const tx = await c[method](...args, { nonce: await nextNonce(actor) });
      usedNonce(actor);
      txCount++;
      pushLog({ type: "tx", actor, message: `${method}() submitted`, txHash: tx.hash, explorerUrl: txUrl(tx.hash) });
      const receipt = await tx.wait();
      cache.at = 0;
      return { tx, receipt };
    } catch (e) {
      const reason = reasonOf(e);
      if (/nonce/i.test(reason)) resyncNonce(actor); // only re-read the chain if the nonce itself was the problem
      pushLog({ type: "error", actor, message: `${method}() failed: ${reason}` });
      const err = new Error(reason);
      err.status = 400;
      throw err;
    }
  });
}

/** Try an action that SHOULD be rejected; the contract refuses before any gas is spent. */
async function attempt(actor, method, args, description) {
  pushLog({ type: "info", actor, message: `${actor.toUpperCase()} (unauthorised) tries: ${description}` });
  try {
    await contract.connect(actors[actor])[method].staticCall(...args);
    // If this ever succeeds the contract is not enforcing the rule.
    pushLog({ type: "error", actor, message: `UNEXPECTED: ${method}() was NOT rejected` });
    return { rejected: false };
  } catch (e) {
    rejectedCount++;
    cache.at = 0;
    const reason = reasonOf(e);
    pushLog({ type: "rejected", actor, message: `REJECTED by the contract: ${reason}` });
    return { rejected: true, reason };
  }
}

// ---------------------------------------------------------------------------
// 3. CHAIN READS (cached briefly to be kind to public RPCs)
// ---------------------------------------------------------------------------
const cache = { at: 0, data: null };

function shapeBatch(id, b) {
  return {
    id,
    label: b.label,
    manufacturer: b.manufacturer,
    manufacturerName: actorNameOf(b.manufacturer),
    certHash: b.qcCertHash,
    holder: b.currentHolder,
    holderName: actorNameOf(b.currentHolder),
    minTemp: asC(b.minSafeTemp),
    maxTemp: asC(b.maxSafeTemp),
    status: STATUS[Number(b.status)],
    registeredAt: Number(b.registeredAt),
  };
}

async function readBatch(id) {
  const b = await contract.getBatch(id);
  return shapeBatch(id, b);
}

async function readDetail(id) {
  const batch = await readBatch(id);
  if (batch.status === "UNREGISTERED") return { batch, custody: [], temps: [] };
  const [cust, tmp] = await Promise.all([contract.getCustodyHistory(id), contract.getTemperatureLog(id)]);
  const custody = await Promise.all(
    cust.map(async (r) => ({
      holder: r.holder,
      holderName: actorNameOf(r.holder),
      role: ROLE[Number(await contract.roles(r.holder))],
      timestamp: Number(r.timestamp),
    }))
  );
  const temps = tmp.map((r) => ({
    reading: asC(r.reading),
    timestamp: Number(r.timestamp),
    reporter: r.reporter,
    reporterName: actorNameOf(r.reporter),
    outOfRange: r.reading > ethers.toBigInt(toTenths(batch.maxTemp)) || r.reading < ethers.toBigInt(toTenths(batch.minTemp)),
  }));
  return { batch, custody, temps };
}

async function snapshot() {
  if (cache.data && Date.now() - cache.at < 2500) return cache.data;
  const ids = await contract.getAllBatchIds();
  const batches = await Promise.all(ids.map(readBatch));
  const actorList = await Promise.all(
    Object.entries(actors).map(async ([name, w]) => ({
      name,
      address: w.address,
      role: name === "regulator" ? "REGULATOR" : ROLE[Number(await contract.roles(w.address))],
      balanceEth: Number(ethers.formatEther(await provider.getBalance(w.address))).toFixed(4),
      explorerUrl: addrUrl(w.address),
    }))
  );
  const counts = {};
  batches.forEach((b) => (counts[b.status] = (counts[b.status] || 0) + 1));
  const data = {
    network: { chainId: chainId.toString(), rpcUrl: RPC_URL, explorerBase: explorerBase() },
    contract: { address: contractAddress, deployTxHash, explorerUrl: addrUrl(contractAddress), deployUrl: deployTxHash ? txUrl(deployTxHash) : "" },
    onboarded: actorList.filter((a) => ["MANUFACTURER", "DISTRIBUTOR", "PHARMACY"].includes(a.role)).length === 3,
    actors: actorList,
    batches,
    analytics: { total: batches.length, byStatus: counts, txCount, rejectedCount },
  };
  cache.data = data;
  cache.at = Date.now();
  return data;
}

function resolveId(q) {
  if (!q) throw Object.assign(new Error("Missing batch id"), { status: 400 });
  q = String(q).trim();
  return /^0x[0-9a-fA-F]{64}$/.test(q) ? q : ethers.id(q);
}

// ---------------------------------------------------------------------------
// 4. EXPRESS API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e) });
  }
};
const txResult = ({ tx }) => ({ txHash: tx.hash, explorerUrl: txUrl(tx.hash) });

app.get("/api/state", wrap(snapshot));

app.get("/api/logs", (req, res) => res.json(ledger));
app.get("/api/logs/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  sseClients.push(res);
  req.on("close", () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// Step 0: regulator whitelists the three participants.
app.post("/api/onboard", wrap(async () => {
  const plan = [
    ["manufacturer", 1],
    ["distributor", 2],
    ["pharmacy", 3],
  ];
  const done = [];
  for (const [name, role] of plan) {
    const current = Number(await contract.roles(actors[name].address));
    if (current === role) continue;
    const r = await sendTx("regulator", "setRole", [actors[name].address, role], `setRole(${name}, ${ROLE[role]})`);
    pushLog({ type: "event", actor: "regulator", message: `RoleSet: ${name} is now an authorised ${ROLE[role]}`, txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash) });
    done.push({ name, ...txResult(r) });
  }
  return { onboarded: done };
}));

// Register a new batch (manufacturer).
app.post("/api/batches", wrap(async (req) => {
  const product = String(req.body.product || "").trim();
  const lot = String(req.body.lot || "").trim();
  if (!product || !lot) throw Object.assign(new Error("Product and lot number are required"), { status: 400 });
  const min = req.body.minTemp === undefined || req.body.minTemp === "" ? 2 : Number(req.body.minTemp);
  const max = req.body.maxTemp === undefined || req.body.maxTemp === "" ? 8 : Number(req.body.maxTemp);
  if (!(min < max)) throw Object.assign(new Error("Min temperature must be below max"), { status: 400 });

  const label = `${lot} | ${product}`;
  const id = ethers.id(label);
  if ((await readBatch(id)).status !== "UNREGISTERED") throw Object.assign(new Error("That lot is already registered"), { status: 400 });

  const certHash = ethers.id(`QC-CERTIFICATE|${label}|${new Date().toISOString().slice(0, 10)}`);
  const r = await sendTx("manufacturer", "registerBatch", [id, label, certHash, toTenths(min), toTenths(max)],
    `registerBatch("${label}", safe range ${min}..${max} C)`);
  pushLog({ type: "event", actor: "manufacturer", message: `BatchRegistered: ${label} (certificate hash ${certHash.slice(0, 12)}...)`, txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash) });
  return { id, label, ...txResult(r) };
}));

app.get("/api/batches/:id", wrap(async (req) => readDetail(resolveId(req.params.id))));

app.post("/api/batches/:id/certify", wrap(async (req) => {
  const id = resolveId(req.params.id);
  const r = await sendTx("regulator", "certifyBatch", [id], "certifyBatch()");
  pushLog({ type: "event", actor: "regulator", message: "BatchCertified: the batch may now move", txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash) });
  return txResult(r);
}));

app.post("/api/batches/:id/transfer", wrap(async (req) => {
  const id = resolveId(req.params.id);
  const to = String(req.body.to || "");
  if (!["distributor", "pharmacy", "counterfeiter", "manufacturer"].includes(to)) throw Object.assign(new Error("Unknown recipient"), { status: 400 });
  const b = await readBatch(id);
  const holder = actorNameOf(b.holder);
  if (!holder) throw Object.assign(new Error("Current holder is not a known demo wallet"), { status: 400 });
  const r = await sendTx(holder, "transferCustody", [id, actors[to].address], `transferCustody(-> ${to})`);
  pushLog({ type: "event", actor: holder, message: `CustodyTransferred: ${holder} -> ${to}`, txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash) });
  return txResult(r);
}));

app.post("/api/batches/:id/temperature", wrap(async (req) => {
  const id = resolveId(req.params.id);
  const reading = Number(req.body.reading);
  if (!Number.isFinite(reading)) throw Object.assign(new Error("Reading must be a number"), { status: 400 });
  const b = await readBatch(id);
  const holder = actorNameOf(b.holder) || "regulator";
  const r = await sendTx(holder, "logTemperature", [id, toTenths(reading)], `logTemperature(${reading.toFixed(1)} C)`);
  const after = await readBatch(id);
  const breached = after.status === "BREACHED";
  pushLog({
    type: "event", actor: holder, txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash),
    message: breached
      ? `ColdChainBreach: ${reading.toFixed(1)} C is outside ${b.minTemp}..${b.maxTemp} C. Batch locked on-chain.`
      : `TemperatureLogged: ${reading.toFixed(1)} C, within the safe range`,
  });
  return { ...txResult(r), breached };
}));

app.post("/api/batches/:id/recall", wrap(async (req) => {
  const id = resolveId(req.params.id);
  const reason = String(req.body.reason || "Safety recall").slice(0, 140);
  const r = await sendTx("regulator", "recallBatch", [id, reason], `recallBatch("${reason}")`);
  pushLog({ type: "event", actor: "regulator", message: `BatchRecalled: ${reason}`, txHash: r.tx.hash, explorerUrl: txUrl(r.tx.hash) });
  return txResult(r);
}));

// Attack simulator: every one of these must be refused by the contract.
app.post("/api/attack", wrap(async (req) => {
  const type = String(req.body.type || "");
  const ids = await contract.getAllBatchIds();
  const target = req.body.id ? resolveId(req.body.id) : ids[0];
  switch (type) {
    case "register": {
      const label = "FAKE-0001 | Counterfeit Vaccine";
      return attempt("counterfeiter", "registerBatch", [ethers.id(label), label, ethers.id("forged"), 20, 80], "registerBatch(a counterfeit batch)");
    }
    case "certify":
      if (!target) throw Object.assign(new Error("Register a batch first"), { status: 400 });
      return attempt("counterfeiter", "certifyBatch", [target], "certifyBatch(a real batch) to forge approval");
    case "steal":
      if (!target) throw Object.assign(new Error("Register a batch first"), { status: 400 });
      return attempt("counterfeiter", "transferCustody", [target, actors.counterfeiter.address], "transferCustody(to itself) to steal a batch");
    case "grant":
      return attempt("counterfeiter", "setRole", [actors.counterfeiter.address, 1], "setRole(itself, MANUFACTURER)");
    case "overwrite":
      if (!target) throw Object.assign(new Error("Register a batch first"), { status: 400 });
      return attempt("manufacturer", "registerBatch", [target, "TAMPERED", ethers.id("forged certificate"), 20, 80], "re-register an existing batch with a forged certificate");
    default:
      throw Object.assign(new Error("Unknown attack"), { status: 400 });
  }
}));

// Public verification (what a pharmacist or patient sees). No wallet needed.
const verifyHandler = wrap(async (req) => {
  const id = resolveId(req.query.q);
  const d = await readDetail(id);
  const s = d.batch.status;
  let verdict, message;
  if (s === "UNREGISTERED") { verdict = "UNKNOWN"; message = "No record of this batch exists on the blockchain. Treat it as COUNTERFEIT."; }
  else if (s === "RECALLED") { verdict = "RECALLED"; message = "The regulator has recalled this batch. Do not dispense."; }
  else if (s === "BREACHED") { verdict = "BREACHED"; message = "The cold chain was broken. This batch may be ineffective or unsafe."; }
  else if (s === "AWAITING_CERT") { verdict = "UNCERTIFIED"; message = "Registered but not yet certified by the regulator. It must not be on sale."; }
  else { verdict = "GENUINE"; message = s === "DELIVERED" ? "Certified, kept within its safe temperature range, and delivered to a registered pharmacy." : "Certified and within its safe temperature range so far."; }
  return { verdict, message, ...d, contract: { address: contractAddress, explorerUrl: addrUrl(contractAddress) }, explorerBase: explorerBase() };
});
app.get("/api/verify", verifyHandler);

// ---------------------------------------------------------------------------
// 5. BOOT
// ---------------------------------------------------------------------------
async function fundActors() {
  for (const name of ["manufacturer", "distributor", "pharmacy"]) {
    const bal = await provider.getBalance(actors[name].address);
    if (bal >= FUND_MIN) continue;
    const need = FUND_TARGET - bal;
    pushLog({ type: "info", actor: "regulator", message: `Funding ${name} wallet with ${ethers.formatEther(need)} test ETH for gas` });
    const tx = await actors.regulator.sendTransaction({ to: actors[name].address, value: need, nonce: await nextNonce("regulator") });
    usedNonce("regulator");
    pushLog({ type: "tx", actor: "regulator", message: `Gas top-up for ${name}`, txHash: tx.hash, explorerUrl: txUrl(tx.hash) });
    await tx.wait();
  }
}

async function boot() {
  // cacheTimeout -1: ethers otherwise caches identical RPC calls for 250 ms, which can return a stale nonce.
  provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const net = await provider.getNetwork();
  chainId = net.chainId;
  console.log(`\nConnected to ${RPC_URL} (chain ID ${chainId})`);
  if (chainId !== SEPOLIA_CHAIN_ID) console.warn("Note: this is not Sepolia, so Etherscan links are hidden.");

  const root = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const derive = (role) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`${process.env.PRIVATE_KEY}:${role}`)), provider);
  actors.regulator = root;
  actors.manufacturer = derive("manufacturer");
  actors.distributor = derive("distributor");
  actors.pharmacy = derive("pharmacy");
  actors.counterfeiter = derive("counterfeiter");

  const bal = await provider.getBalance(root.address);
  console.log(`Regulator wallet: ${root.address}`);
  console.log(`Balance: ${ethers.formatEther(bal)} ETH`);
  if (bal < ethers.parseEther("0.02")) {
    console.warn("Low balance: deployment + funding the 3 role wallets needs roughly 0.015 ETH on Sepolia. Top up from a faucet if it fails.");
  }

  if (process.env.CONTRACT_ADDRESS) {
    contractAddress = process.env.CONTRACT_ADDRESS;
    contract = new ethers.Contract(contractAddress, compiled.abi, root);
    pushLog({ type: "info", message: `Attached to existing PharmaChain at ${contractAddress}` });
    console.log(`Attached to existing contract ${contractAddress}`);
  } else {
    console.log("Deploying PharmaChain ...");
    const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, root);
    const deployed = await factory.deploy(root.address, { nonce: await nextNonce("regulator") });
    usedNonce("regulator");
    deployTxHash = deployed.deploymentTransaction().hash;
    pushLog({ type: "tx", actor: "regulator", message: "PharmaChain deployment submitted", txHash: deployTxHash, explorerUrl: txUrl(deployTxHash) });
    await deployed.waitForDeployment();
    contract = deployed;
    contractAddress = await deployed.getAddress();
    pushLog({ type: "event", actor: "regulator", message: `PharmaChain deployed at ${contractAddress}`, txHash: deployTxHash, explorerUrl: txUrl(deployTxHash) });
    console.log(`Deployed PharmaChain at ${contractAddress}`);
    if (explorerBase()) console.log(`Explorer: ${addrUrl(contractAddress)}`);
    console.log(`(Tip: to re-use this contract next time, add CONTRACT_ADDRESS=${contractAddress} to .env)`);
  }

  await fundActors();
  app.listen(PORT, () => {
    console.log(`\nDashboard:          http://localhost:${PORT}`);
    console.log(`Public verify page: http://localhost:${PORT}/verify\n`);
  });
}

boot().catch((e) => {
  const inner = (e.error && e.error.message) || (e.info && e.info.error && e.info.error.message) || "";
  console.error("\nFailed to start:", e.shortMessage || e.message, inner ? `(${inner})` : "");
  process.exit(1);
});