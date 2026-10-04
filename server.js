// Hisaab mock server — zero-dependency MCP server (JSON-RPC over HTTP) faking the 3 capabilities
// Pine Labs does not offer today (Round 2, "MUST BUILD"):
//   1. fetch_open_invoices   -> school-portal bill presentment
//   2. verify_payee          -> verified-institution registry (payee binding)
//   3. tag_payment_to_child  -> per-child ledger
// Plus a Delhivery-shaped pin-code serviceability REST endpoint.
// Run: node server.js   |  MCP endpoint: POST /mcp
// Force failures while recording:  GET /admin/scenario?tool=fetch_open_invoices&mode=timeout|error|malformed|empty|ok
// Reset: GET /admin/reset
const http = require("http");
// ---------- state ----------
const DEFAULT_MODES = { fetch_open_invoices: "ok", verify_payee: "ok", tag_payment_to_child: "ok" };
let modes = { ...DEFAULT_MODES };
const ledger = []; // tag_payment_to_child writes here (idempotent per payment_id)
const reserve = { debited: 0 }; // UPI Reserve Pay block of INR 10,000
const debits = {};              // idempotency_key -> debit record
// pay_fee modes: ok | declined | no_receipt | timeout | error
// check_cap_balance modes: ok | timeout | error
// To simulate a LOW balance: GET /admin/spend?amount=9000

// ---------- data ----------
const INSTITUTIONS = {
  INST_STMARYS: { name: "St. Mary's School, Kolkata", verified: true, phone: "+91-33-0000-0001", office_hours: "09:00-16:00" },
  INST_DANCE:   { name: "Nrityanjali Dance Academy",   verified: true, phone: "+91-33-0000-0002", office_hours: "10:00-18:00" },
  INST_BRIGHT:  { name: "BrightPath Coaching Centre",  verified: false }, // NOT in household registry
};
const INVOICES = [
  { invoice_id: "INV-2026-0412", school_id: "INST_STMARYS", child_id: "CH_AANYA", child_name: "Aanya Sen",
    description: "Term 3 tuition", amount: 4200, currency: "INR", due_date: "2026-10-10", status: "OPEN" },
  { invoice_id: "INV-2026-0413", school_id: "INST_DANCE", child_id: "CH_AANYA", child_name: "Aanya Sen",
    description: "Annual day dance costume fee", amount: 1800, currency: "INR", due_date: "2026-10-12", status: "OPEN" },
  { invoice_id: "INV-2026-0501", school_id: "INST_BRIGHT", child_id: null, child_name: "Sen",
    description: "Olympiad coaching fee (surname only)", amount: 6500, currency: "INR", due_date: "2026-10-09", status: "OPEN" },
];

// ---------- tool implementations ----------
const tools = {
  fetch_open_invoices: {
    description: "Return the fees currently outstanding for a household at a school/institution. Input: school_id (e.g. INST_STMARYS), optional child_id.",
    inputSchema: { type: "object", properties: { school_id: { type: "string" }, child_id: { type: "string" } }, required: ["school_id"] },
    run: (a) => {
      const rows = INVOICES.filter(i => i.school_id === a.school_id && i.status === "OPEN" && (!a.child_id || i.child_id === a.child_id));
      return { school_id: a.school_id, count: rows.length, invoices: rows, fetched_at: new Date().toISOString() };
    },
  },
  verify_payee: {
    description: "Check an institution against the household's verified-payee registry. Input: institution_id. Returns verified true/false and the payee record. Never pay an unverified payee.",
    inputSchema: { type: "object", properties: { institution_id: { type: "string" } }, required: ["institution_id"] },
    run: (a) => {
      const inst = INSTITUTIONS[a.institution_id];
      if (!inst) return { institution_id: a.institution_id, verified: false, reason: "NOT_IN_REGISTRY" };
      return { institution_id: a.institution_id, verified: inst.verified, reason: inst.verified ? "OK" : "NOT_APPROVED_BY_HOUSEHOLD",
               name: inst.name, accounts_office_phone: inst.phone, office_hours_ist: inst.office_hours };
    },
  },
  // ---- Pine Labs P3P-shaped mocks (only because the platform's Pine Labs connector lacks Reserve Pay tools) ----
  check_cap_balance: {
    description: "Pine Labs P3P getMandateBalance(): read the standing UPI Reserve Pay block balance FRESH. Input: authorisation_id. Returns blocked, debited, remaining (INR).",
    inputSchema: { type: "object", properties: { authorisation_id: { type: "string" } }, required: ["authorisation_id"] },
    run: (a) => ({ authorisation_id: a.authorisation_id, currency: "INR", blocked: 10000, debited: reserve.debited, remaining: 10000 - reserve.debited, read_at: new Date().toISOString() }),
  },
  pay_fee: {
    description: "Pine Labs P3P debitGrantexBudget() with RESERVE_PAY. Input: idempotency_key (one per invoice), amount, payee_id, child_id. Returns debit result and signed payment receipt. Same key twice never debits twice.",
    inputSchema: { type: "object", properties: { idempotency_key: { type: "string" }, amount: { type: "number" }, payee_id: { type: "string" }, child_id: { type: "string" } }, required: ["idempotency_key", "amount", "payee_id"] },
    run: (a) => {
      const prev = debits[a.idempotency_key];
      if (prev) return { ...prev, duplicate: true };
      const mode = modes.pay_fee || "ok";
      if (mode === "declined") return { status: "PAYMENT_FAILED", reason: "MANDATE_EXPIRED", receipt: null };
      if (a.amount > 10000 - reserve.debited) return { status: "PAYMENT_FAILED", reason: "INSUFFICIENT_RESERVE", receipt: null, remaining: 10000 - reserve.debited };
      reserve.debited += a.amount;
      const receipt = mode === "no_receipt" ? null : { receipt_id: "RCPT-" + a.idempotency_key, signature: "sig_" + Buffer.from(a.idempotency_key).toString("hex").slice(0, 16), payee_id: a.payee_id, amount: a.amount, paid_at: new Date().toISOString() };
      const rec = { status: "DEBITED", idempotency_key: a.idempotency_key, amount: a.amount, receipt, remaining: 10000 - reserve.debited };
      debits[a.idempotency_key] = rec;
      return rec;
    },
  },
  check_debit_status: {
    description: "Pine Labs P3P getDebitStatus(): the true state of one debit by its idempotency key. Use this after a timeout instead of re-debiting.",
    inputSchema: { type: "object", properties: { idempotency_key: { type: "string" } }, required: ["idempotency_key"] },
    run: (a) => debits[a.idempotency_key] ? { status: debits[a.idempotency_key].status, receipt: debits[a.idempotency_key].receipt } : { status: "UNKNOWN" },
  },
  // ---- Gnani (REAL calls, wrapped so the agent only sees simple JSON tools) ----
  // Needs env var GNANI_API_KEY. Docs: https://docs.gnani.ai/api/STT/speech-to-text and /api/TTS/tts-inference
  gnani_transcribe: {
    description: "Gnani speech-to-text (REAL). Input: audio_url (public link to a WAV/MP3/OGG/M4A clip, max 60 s) and language_code (hi-IN, en-IN, bn-IN, ...). Returns {transcript}. Use for the parent's voice notes and for the school's call recording.",
    inputSchema: { type: "object", properties: { audio_url: { type: "string" }, language_code: { type: "string", default: "hi-IN" } }, required: ["audio_url"] },
    run: async (a) => {
      const key = process.env.GNANI_API_KEY;
      if (!key) return { success: false, error: "GNANI_API_KEY is not set on the server" };
      try {
        const audio = await fetch(a.audio_url);
        if (!audio.ok) return { success: false, error: "could not download audio_url: HTTP " + audio.status };
        const form = new FormData();
        form.append("audio_file", new Blob([await audio.arrayBuffer()]), "audio.wav");
        form.append("language_code", a.language_code || "hi-IN");
        form.append("format", "transcribe");
        const r = await fetch("https://api.vachana.ai/stt/v3", { method: "POST", headers: { "X-API-Key-ID": key }, body: form });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { success: true, transcript: j.transcript, request_id: j.request_id } : { success: false, status: r.status, error: j };
      } catch (e) { return { success: false, error: String(e) }; }
    },
  },
  gnani_speak: {
    description: "Gnani text-to-speech (REAL). Input: text, optional voice (Nalini=Hindi, Kaveri=English, Poorvi=Hinglish) and language (hi-IN, en-IN, hi-en). Returns an audio_url that plays the speech. Write amounts as words, e.g. 'four thousand two hundred rupees'.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, voice: { type: "string", default: "Nalini" }, language: { type: "string", default: "hi-IN" } }, required: ["text"] },
    run: (a, baseUrl) => {
      const q = new URLSearchParams({ text: a.text, voice: a.voice || "Nalini", language: a.language || "hi-IN" });
      return { success: true, audio_url: `${baseUrl}/gnani/tts?${q}`, note: "audio is generated when the URL is opened" };
    },
  },
  tag_payment_to_child: {
    description: "Log a settled payment against a child's ledger. Input: payment_id, child_id, invoice_id, amount. Idempotent on payment_id.",
    inputSchema: { type: "object", properties: { payment_id: { type: "string" }, child_id: { type: "string" }, invoice_id: { type: "string" }, amount: { type: "number" } }, required: ["payment_id", "child_id"] },
    run: (a) => {
      let row = ledger.find(l => l.payment_id === a.payment_id);
      const duplicate = !!row;
      if (!row) { row = { ...a, logged_at: new Date().toISOString() }; ledger.push(row); }
      const childTotal = ledger.filter(l => l.child_id === a.child_id).reduce((s, l) => s + (l.amount || 0), 0);
      return { status: "LOGGED", duplicate, entry: row, child_year_total: childTotal };
    },
  },
};

// ---------- failure injection ----------
function applyMode(toolName, result) {
  const mode = modes[toolName] || "ok";
  switch (mode) {
    case "timeout":   return { delay: 35000, result };                       // exceeds typical client timeout
    case "error":     return { error: { code: -32000, message: "503 upstream school portal unavailable" } };
    case "malformed": return { raw: "<<html>Gateway</html> {invoices: [ ,,", result: null }; // garbage text
    case "empty":     return { result: { ...result, count: 0, invoices: [] } };
    default:          return { result };
  }
}

// ---------- MCP JSON-RPC ----------
async function handleMcp(body, baseUrl) {
  const { id, method, params } = body || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize")
    return ok({ protocolVersion: params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "hisaab-mock", version: "1.0.0" } });
  if (method === "notifications/initialized") return null;
  if (method === "ping") return ok({});
  if (method === "tools/list")
    return ok({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const t = tools[params?.name];
    if (!t) return fail(-32602, `Unknown tool ${params?.name}`);
    const out = applyMode(params.name, await t.run(params.arguments || {}, baseUrl));
    if (out.delay) await new Promise(r => setTimeout(r, out.delay));
    if (out.error) return fail(out.error.code, out.error.message);
    if (out.raw) return ok({ content: [{ type: "text", text: out.raw }] });
    return ok({ content: [{ type: "text", text: JSON.stringify(out.result) }] });
  }
  return fail(-32601, `Method not found: ${method}`);
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/plain" : "application/json" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, q = Object.fromEntries(url.searchParams);
  if (req.method === "POST" && p === "/mcp") {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", async () => {
      let body; try { body = JSON.parse(data || "{}"); } catch { return send(res, 400, { error: "bad json" }); }
      const proto = req.headers["x-forwarded-proto"] || "http";
      const out = await handleMcp(body, `${proto}://${req.headers.host}`);
      if (out === null) { res.writeHead(202); return res.end(); }
      send(res, 200, out);
    });
    return;
  }
  // Delhivery-shaped pin-code serviceability (same path and fields as their docs)
  if (p === "/c/api/pin-codes/json/") {
    const pin = q.filter_codes;
    if (pin === "000000") return send(res, 200, { delivery_codes: [] });
    return send(res, 200, { delivery_codes: [{ postal_code: { pin, district: "Kolkata", pre_paid: "Y", cash: "Y", pickup: "Y", repl: "N", cod: "Y", is_oda: "N", state_code: "WB" } }] });
  }
  // Gnani TTS audio, generated on demand so the server stays stateless
  if (p === "/gnani/tts") {
    const key = process.env.GNANI_API_KEY;
    if (!key) return send(res, 500, { error: "GNANI_API_KEY is not set on the server" });
    fetch("https://api.vachana.ai/api/v1/tts/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key-ID": key },
      body: JSON.stringify({ text: q.text || "", voice: q.voice || "Nalini", model: "timbre-v2.5", language: q.language || "hi-IN",
        audio_config: { encoding: "linear_pcm", container: "wav", sample_rate: 24000, num_channels: 1, sample_width: 2 } }),
    }).then(async (r) => {
      if (!r.ok) return send(res, r.status, { error: "gnani tts failed", detail: await r.text() });
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(Buffer.from(await r.arrayBuffer()));
    }).catch((e) => send(res, 502, { error: String(e) }));
    return;
  }
  if (p === "/admin/spend") { reserve.debited += Number(q.amount || 0); return send(res, 200, reserve); }
  if (p === "/admin/scenario") { modes[q.tool] = q.mode; return send(res, 200, modes); }
  if (p === "/admin/reset") { modes = { ...DEFAULT_MODES }; ledger.length = 0; reserve.debited = 0; for (const k in debits) delete debits[k]; return send(res, 200, { reset: true, modes }); }
  if (p === "/admin/ledger") return send(res, 200, ledger);
  send(res, 200, "hisaab-mock up. POST /mcp");
};

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  http.createServer(handler).listen(PORT, () => console.log("hisaab-mock on :" + PORT));
}
module.exports = handler; // Vercel serverless entry