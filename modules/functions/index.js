// CapLynk recruiter backend (modules 1-4), deployed as its own Functions codebase ("modules").
//   profiles   POST /api/profiles          Claude: CV -> contact details + SFIA profile, JD -> required skills, client summary
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
const SFIA_CODES = "PROG Programming/software development; SWDN Software design; ARCH Solution architecture; TEST Testing; SINT Systems integration and build; RELM Release and deployment; CFMG Configuration management; DLMG Systems development management; DBDS Database design; DBAD Database administration; DATM Data management; DENG Data engineering; DTAN Data modelling and design; DATS Data science; MLNG Machine learning; BINT Business intelligence; VISL Data visualisation; ITOP Infrastructure operations; SYSP System software; NTDS Network design; NTAS Network support; SCTY Information security; SCAD Security operations; PENT Penetration testing; VUAS Vulnerability assessment; PRMG Project management; PGMG Programme management; BUAN Business situation analysis; REQM Requirements definition and management; BPRE Business process improvement; HCEV User experience design; URCH User research; USUP Incident management; PBMG Problem management; CHMG Change control; SLMO Service level management; RLMT Stakeholder relationship management; CNSL Consultancy; QUAS Quality assurance; ITSP Strategic planning; GOVN Governance";
const LEVEL_GUIDE = "SFIA levels: 1 Follow, 2 Assist, 3 Apply, 4 Enable, 5 Ensure/advise, 6 Initiate/influence, 7 Set strategy. Judge level from responsibility and autonomy shown, not years alone.";

const CV_TOOL = {
  name: "save_candidate",
  description: "Save the candidate's personal and contact details and SFIA skill profile extracted from their CV.",
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
        type: "array", maxItems: 12,
        items: { type: "object", properties: { code: { type: "string" }, level: { type: "integer", minimum: 1, maximum: 7 }, evidence: { type: "string", description: "Short phrase from the CV" } }, required: ["code", "level", "evidence"] },
      },
    },
    required: ["name", "email", "phone", "location", "headline", "skills"],
  },
};
const JOB_TOOL = {
  name: "save_role_profile",
  description: "Save the SFIA skills a job description requires.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array", maxItems: 10,
        items: { type: "object", properties: { code: { type: "string" }, minLevel: { type: "integer", minimum: 1, maximum: 7 }, mustHave: { type: "boolean" } }, required: ["code", "minLevel", "mustHave"] },
      },
    },
    required: ["skills"],
  },
};

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
      const profile = await claudeTool(CV_TOOL,
        `You extract candidate details from CVs for a skills-based recruiter. Use only SFIA codes from this list: ${SFIA_CODES}. ${LEVEL_GUIDE} Leave a field empty if the CV doesn't state it; never invent contact details.`,
        "CV text:\n\n" + String(text || "").slice(0, 60000));
      return res.json({ profile });
    }
    if (action === "job") {
      const profile = await claudeTool(JOB_TOOL,
        `You turn job descriptions into SFIA skill requirements. Use only codes from this list: ${SFIA_CODES}. ${LEVEL_GUIDE} mustHave is true for essential or required skills.`,
        "Job description:\n\n" + String(text || "").slice(0, 30000));
      return res.json({ profile });
    }
    if (action === "summary") {
      const { candidate = {}, role = {}, match = {} } = req.body;
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const msg = await client.messages.create({
        model: CLAUDE_MODEL.value(), max_tokens: 400,
        system: "You write the summary paragraph a recruiter sends a client about a shortlisted candidate. 3 to 4 sentences, plain British English, factual, no hype, no contact details. Mention fit against the role's SFIA skills and one area to probe at interview if there is a gap.",
        messages: [{ role: "user", content: JSON.stringify({ candidate, role, match }).slice(0, 20000) }],
      });
      return res.json({ summary: msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() });
    }
    res.status(400).send("Unknown action");
  } catch (err) {
    console.error("profiles failed", err);
    res.status(502).send("Claude request failed");
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
