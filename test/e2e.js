const B = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  -> " + extra : "")); };
const call = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json() }; };

(async () => {
  let st = (await call("GET", "/api/state")).d;
  ok("state: 5 actors, not onboarded", st.actors.length === 5 && st.onboarded === false);

  // before onboarding, a manufacturer cannot register
  let r = await call("POST", "/api/batches", { product: "Rotavirus Vaccine", lot: "PFZ-1" });
  ok("register BEFORE onboarding is rejected", r.s === 400 && /not an authorised manufacturer/.test(r.d.error), r.d.error);

  r = await call("POST", "/api/onboard");
  ok("onboard 3 roles", r.s === 200 && r.d.onboarded.length === 3);
  st = (await call("GET", "/api/state")).d;
  ok("state: onboarded", st.onboarded === true);

  r = await call("POST", "/api/batches", { product: "Rotavirus Vaccine", lot: "PFZ-2201" });
  ok("register batch", r.s === 200 && r.d.id);
  const A = r.d.id;
  r = await call("POST", "/api/batches", { product: "Rotavirus Vaccine", lot: "PFZ-2201" });
  ok("duplicate register rejected", r.s === 400, r.d.error);

  r = await call("POST", `/api/batches/${A}/transfer`, { to: "distributor" });
  ok("transfer before certification rejected", r.s === 400 && /not certified/.test(r.d.error), r.d.error);

  // attacks
  for (const t of ["register", "certify", "steal", "grant", "overwrite"]) {
    r = await call("POST", "/api/attack", { type: t, id: A });
    ok(`attack '${t}' blocked by contract`, r.d.rejected === true, r.d.reason);
  }

  r = await call("POST", `/api/batches/${A}/certify`);
  ok("certify", r.s === 200);
  r = await call("POST", `/api/batches/${A}/certify`);
  ok("double certify rejected", r.s === 400, r.d.error);

  r = await call("POST", `/api/batches/${A}/temperature`, { reading: 5 });
  ok("normal reading logged, no breach", r.s === 200 && r.d.breached === false);
  r = await call("POST", `/api/batches/${A}/transfer`, { to: "distributor" });
  ok("manufacturer -> distributor", r.s === 200);
  r = await call("POST", `/api/batches/${A}/temperature`, { reading: 4.5 });
  ok("distributor logs reading", r.s === 200 && r.d.breached === false);
  r = await call("POST", `/api/batches/${A}/transfer`, { to: "counterfeiter" });
  ok("transfer to unauthorised wallet rejected", r.s === 400 && /not an authorised distributor or pharmacy/.test(r.d.error), r.d.error);
  r = await call("POST", `/api/batches/${A}/transfer`, { to: "pharmacy" });
  ok("distributor -> pharmacy (delivered)", r.s === 200);

  let v = (await call("GET", `/api/verify?q=${encodeURIComponent("PFZ-2201 | Rotavirus Vaccine")}`)).d;
  ok("verify by label: GENUINE + delivered", v.verdict === "GENUINE" && v.batch.status === "DELIVERED", v.message);
  ok("custody has 3 hops", v.custody.length === 3, v.custody.map((c) => c.holderName).join(" > "));
  ok("2 temp readings", v.temps.length === 2);
  r = await call("POST", `/api/batches/${A}/transfer`, { to: "manufacturer" });
  ok("delivered batch cannot move again", r.s === 400, r.d.error);

  // second batch: hot breach
  r = await call("POST", "/api/batches", { product: "Insulin Glargine", lot: "INS-77", minTemp: 2, maxTemp: 8 });
  const Bx = r.d.id;
  await call("POST", `/api/batches/${Bx}/certify`);
  r = await call("POST", `/api/batches/${Bx}/temperature`, { reading: 9.5 });
  ok("hot reading 9.5 triggers breach", r.s === 200 && r.d.breached === true);
  v = (await call("GET", `/api/verify?q=${Bx}`)).d;
  ok("verify by id: BREACHED", v.verdict === "BREACHED");
  r = await call("POST", `/api/batches/${Bx}/transfer`, { to: "distributor" });
  ok("breached batch cannot move", r.s === 400, r.d.error);
  r = await call("POST", `/api/batches/${Bx}/temperature`, { reading: 5 });
  ok("breached batch cannot log further", r.s === 400, r.d.error);

  // third batch: freeze breach
  r = await call("POST", "/api/batches", { product: "MMR Vaccine", lot: "MMR-5" });
  const Cx = r.d.id;
  await call("POST", `/api/batches/${Cx}/certify`);
  r = await call("POST", `/api/batches/${Cx}/temperature`, { reading: -1 });
  ok("freeze reading -1.0 triggers breach", r.d.breached === true);

  // fourth: recall
  r = await call("POST", "/api/batches", { product: "Adalimumab", lot: "ADA-9" });
  const Dx = r.d.id;
  await call("POST", `/api/batches/${Dx}/certify`);
  r = await call("POST", `/api/batches/${Dx}/recall`, { reason: "Contamination report" });
  ok("recall", r.s === 200);
  v = (await call("GET", `/api/verify?q=${Dx}`)).d;
  ok("verify: RECALLED", v.verdict === "RECALLED");
  r = await call("POST", `/api/batches/${Dx}/recall`, { reason: "again" });
  ok("double recall rejected", r.s === 400, r.d.error);

  // counterfeit
  v = (await call("GET", `/api/verify?q=${encodeURIComponent("FAKE-1 | Counterfeit")}`)).d;
  ok("unknown batch => UNKNOWN", v.verdict === "UNKNOWN", v.message);

  st = (await call("GET", "/api/state")).d;
  ok("analytics", st.analytics.total === 4 && st.analytics.rejectedCount >= 5, JSON.stringify(st.analytics.byStatus) + " tx=" + st.analytics.txCount + " blocked=" + st.analytics.rejectedCount);

  const html = await (await fetch(B + "/")).text();
  const vh = await (await fetch(B + "/verify")).text();
  ok("dashboard + verify pages served", html.includes("PharmaChain") && vh.includes("Verify a medicine batch"));
  const logs = await (await fetch(B + "/api/logs")).json();
  ok("ledger has entries incl. rejected", logs.length > 20 && logs.some((l) => l.type === "rejected"), logs.length + " entries");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
