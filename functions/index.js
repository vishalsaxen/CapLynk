// CapLynk chat backend: one HTTPS Cloud Function that streams Claude's reply.
// The Anthropic API key lives in Secret Manager, never in the browser.
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-sonnet-5-5" });
const REQUIRE_AUTH = defineString("REQUIRE_AUTH", { default: "true" });

const SYSTEM_PROMPT =
  "You are the assistant inside CapLynk, a web app that is in early development. " +
  "Be concise and practical. Use Markdown for lists and code.";

exports.chat = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 300, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Use POST");

    // Only signed-in Firebase users may spend API credits.
    if (REQUIRE_AUTH.value() === "true") {
      const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
      try {
        await getAuth().verifyIdToken(token);
      } catch {
        return res.status(401).send("Sign in to chat.");
      }
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const clean = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
    if (!clean.length || clean[clean.length - 1].role !== "user") {
      return res.status(400).send("The last message must be from the user.");
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-cache");

    try {
      const stream = client.messages.stream({
        model: CLAUDE_MODEL.value(),
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: clean,
      });
      stream.on("text", (delta) => res.write(delta));
      await stream.finalMessage();
      res.end();
    } catch (err) {
      console.error("Claude request failed", err);
      if (!res.headersSent) res.status(502).send("Claude request failed.");
      else res.end("\n\n_(The reply was interrupted.)_");
    }
  }
);
