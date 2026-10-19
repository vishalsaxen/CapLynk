// CapLynk recruiter backend (modules 1-4), deployed as its own Functions codebase ("modules").
//   profiles   POST /api/profiles          Claude: CV -> contact details + taxonomy skill profile, JD -> required skills, client summary
//   waSend     POST /api/whatsapp/send     WhatsApp Business Cloud API send, stored in the candidate's conversation
//   waWebhook  GET/POST /api/whatsapp/webhook  Meta webhook: candidate replies and delivery receipts
// Secrets live in Secret Manager; nothing here is exposed to the browser.
const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-sonnet-5-5" });
const WA_TOKEN = defineSecret("WA_TOKEN");               // permanent system-user access token
const WA_APP_SECRET = defineSecret("WA_APP_SECRET");     // Meta app secret, verifies webhook signatures
const WA_VERIFY_TOKEN = defineSecret("WA_VERIFY_TOKEN"); // any string; paste the same into the Meta webhook setup
const WA_PHONE_NUMBER_ID = defineString("WA_PHONE_NUMBER_ID", { default: "" });
const WA_TEMPLATE = defineString("WA_TEMPLATE", { default: "caplynk_outreach" }); // approved template, one body variable {{1}}
const WA_TEMPLATE_LANG = defineString("WA_TEMPLATE_LANG", { default: "en" });
const GRAPH = "https://graph.facebook.com/v21.0";

const opts = { cors: true, region: "us-central1", timeoutSeconds: 120 };

async function requireUser(req, res) {
  const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
  try { return await getAuth().verifyIdToken(token); }
  catch { res.status(401).send("Sign in first."); return null; }
}

// Claude parsing spends API credit, so only the Super Admin (admin.html) may call it; candidates sign up publicly.
const ADMIN_EMAIL = "vaani.s@gaplyn.com";
async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL || !user.email_verified) { res.status(403).send("Super Admin only."); return null; }
  return user;
}

// ---------------------------------------------------------------- profiles
// Skills come from the CapLynk Capability Taxonomy the Super Admin imports on admin.html (Firestore taxonomy/*).
// Cached per instance for ten minutes so a re-import is picked up without a redeploy.
let taxCache = null, taxAt = 0;
async function taxonomy() {
  if (taxCache && Date.now() - taxAt < 10 * 60e3) return taxCache;
  const [meta, skills] = await Promise.all([db.doc("taxonomy/meta").get(), db.doc("taxonomy/skills").get()]);
  if (!meta.exists || !skills.exists) throw Object.assign(new Error("Import the CapLynk Capability Taxonomy on admin.html first."), { status: 409 });
  const levels = meta.data().levels || [];
  const items = skills.data().items || [];
  taxCache = {
    maxLevel: Math.max(...levels.map((l) => l.level), 1),
    levelGuide: "Proficiency levels: " + levels.map((l) => `L${l.level} ${l.name}: ${l.description}`).join(" ") + " Judge level from the autonomy, complexity and influence shown, not years alone.",
    skillList: items.map((s) => `${s.code} ${s.name}${s.aliases?.length ? " (" + s.aliases.slice(0, 4).join(", ") + ")" : ""}`).join("; "),
  };
  taxAt = Date.now();
  return taxCache;
}

const cvTool = (max) => ({
  name: "save_candidate",
  description: "Save the candidate's personal and contact details and skill profile extracted from their CV.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" }, email: { type: "string" },
      phone: { type: "string", description: "As written, with country code if present" },
      location: { type: "string" }, linkedin: { type: "string" },
      headline: { type: "string", description: "Current or most recent job title" },
      yearsExperience: { type: ["number", "null"] },
      summary: { type: "string", description: "Two neutral sentences on their background, for a recruiter" },
      skills: {
        type: "array", maxItems: 15,
        items: { type: "object", properties: { code: { type: "string", description: "Skill ID from the taxonomy" }, level: { type: "integer", minimum: 1, maximum: max }, evidence: { type: "string", description: "Short phrase from the CV" } }, required: ["code", "level", "evidence"] },
      },
    },
    required: ["name", "email", "phone", "location", "headline", "skills"],
  },
});
const jobTool = (max) => ({
  name: "save_role_profile",
  description: "Save the taxonomy skills a job description requires.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array", maxItems: 15,
        items: { type: "object", properties: { code: { type: "string", description: "Skill ID from the taxonomy" }, minLevel: { type: "integer", minimum: 1, maximum: max }, mustHave: { type: "boolean" } }, required: ["code", "minLevel", "mustHave"] },
      },
    },
    required: ["skills"],
  },
});

async function claudeTool(tool, system, content) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const msg = await client.messages.create({
    model: CLAUDE_MODEL.value(), max_tokens: 2048, system,
    tools: [tool], tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content }],
  });
  return msg.content.find((b) => b.type === "tool_use")?.input || {};
}

exports.profiles = onRequest({ ...opts, secrets: [ANTHROPIC_API_KEY] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Use POST");
  if (!(await requireAdmin(req, res))) return;
  const { action, text } = req.body || {};
  try {
    if (action === "cv") {
      const tax = await taxonomy();
      const profile = await claudeTool(cvTool(tax.maxLevel),
        `You extract candidate details from CVs for a skills-based recruiter using the CapLynk Capability Taxonomy. Use only skill IDs from this list: ${tax.skillList}. ${tax.levelGuide} Leave a field empty if the CV doesn't state it; never invent contact details.`,
        "CV text:\n\n" + String(text || "").slice(0, 60000));
      return res.json({ profile });
    }
    if (action === "job") {
      const tax = await taxonomy();
      const profile = await claudeTool(jobTool(tax.maxLevel),
        `You turn job descriptions into skill requirements using the CapLynk Capability Taxonomy. Use only skill IDs from this list: ${tax.skillList}. ${tax.levelGuide} mustHave is true for essential or required skills.`,
        "Job description:\n\n" + String(text || "").slice(0, 30000));
      return res.json({ profile });
    }
    if (action === "summary") {
      const { candidate = {}, role = {}, match = {} } = req.body;
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const msg = await client.messages.create({
        model: CLAUDE_MODEL.value(), max_tokens: 400,
        system: "You write the summary paragraph a recruiter sends a client about a shortlisted candidate. 3 to 4 sentences, plain British English, factual, no hype, no contact details. Mention fit against the role's required skills and one area to probe at interview if there is a gap.",
        messages: [{ role: "user", content: JSON.stringify({ candidate, role, match }).slice(0, 20000) }],
      });
      return res.json({ summary: msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() });
    }
    res.status(400).send("Unknown action");
  } catch (err) {
    console.error("profiles failed", err);
    res.status(err.status || 502).send(err.status ? err.message : "Claude request failed");
  }
});

// ---------------------------------------------------------------- WhatsApp
const digits = (s) => String(s || "").replace(/\D/g, "");

exports.waSend = onRequest({ ...opts, secrets: [WA_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Use POST");
  const user = await requireUser(req, res); if (!user) return;
  const { candidateId, to, text, useTemplate } = req.body || {};
  const phone = digits(to);
  if (!candidateId || !phone || !String(text || "").trim()) return res.status(400).send("candidateId, to and text are required");
  if (!WA_PHONE_NUMBER_ID.value()) return res.status(503).send("WhatsApp Business API is not configured");

  const convRef = db.doc(`users/${user.uid}/conversations/${candidateId}`);
  const conv = await convRef.get();
  if (conv.exists && conv.data().status === "closed") return res.status(409).send("This chat is closed");

  // Outside WhatsApp's 24-hour service window only approved templates may be sent.
  const body = useTemplate
    ? { messaging_product: "whatsapp", to: phone, type: "template", template: { name: WA_TEMPLATE.value(), language: { code: WA_TEMPLATE_LANG.value() }, components: [{ type: "body", parameters: [{ type: "text", text: String(text).replace(/\s*\n\s*/g, " ").slice(0, 1000) }] }] } }
    : { messaging_product: "whatsapp", to: phone, type: "text", text: { body: String(text).slice(0, 4096), preview_url: false } };
  const r = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID.value()}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN.value()}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("WhatsApp send failed", out); return res.status(502).send(out.error?.message || "WhatsApp send failed"); }

  const messageId = out.messages?.[0]?.id || crypto.randomUUID();
  const at = new Date().toISOString();
  await convRef.set({
    id: candidateId, candidateId, phone, status: "open", lastAt: at, updatedAt: at,
    ...(conv.exists ? {} : { createdAt: at, nextStep: "", nextStepDue: "", roleId: "" }),
    messages: FieldValue.arrayUnion({ id: messageId, dir: "out", text: String(text), at, via: "api", status: "sent", template: !!useTemplate }),
  }, { merge: true });
  // Index by phone so the webhook can file replies under the right recruiter and candidate.
  await db.doc(`waIndex/${phone}`).set({ uid: user.uid, candidateId, at });
  res.json({ messageId });
});

exports.waWebhook = onRequest({ region: "us-central1", secrets: [WA_APP_SECRET, WA_VERIFY_TOKEN] }, async (req, res) => {
  if (req.method === "GET") {
    const ok = req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WA_VERIFY_TOKEN.value();
    return ok ? res.status(200).send(req.query["hub.challenge"]) : res.sendStatus(403);
  }
  const sig = req.get("X-Hub-Signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", WA_APP_SECRET.value()).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);

  const values = (req.body.entry || []).flatMap((e) => (e.changes || []).map((c) => c.value || {}));
  for (const v of values) {
    for (const m of v.messages || []) {
      const idx = await db.doc(`waIndex/${digits(m.from)}`).get();
      if (!idx.exists) { console.warn("Reply from unknown number", m.from); continue; }
      const { uid, candidateId } = idx.data();
      const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || `[${m.type} message]`;
      const at = new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString();
      await db.doc(`users/${uid}/conversations/${candidateId}`).set({
        lastAt: at, updatedAt: at, unread: true,
        messages: FieldValue.arrayUnion({ id: m.id, dir: "in", text, at, via: "api" }),
      }, { merge: true });
    }
    for (const s of v.statuses || []) {
      const idx = await db.doc(`waIndex/${digits(s.recipient_id)}`).get();
      if (!idx.exists) continue;
      const ref = db.doc(`users/${idx.data().uid}/conversations/${idx.data().candidateId}`);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref); if (!snap.exists) return;
        const messages = (snap.data().messages || []).map((x) => (x.id === s.id ? { ...x, status: s.status } : x));
        tx.update(ref, { messages });
      });
    }
  }
  res.sendStatus(200);
});
