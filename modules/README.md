# CapLynk recruiter workspace (modules 1 to 4)

One page, `web/recruiter.html`, with three tabs. It builds on the sign-in and app shell in `public/`.

| Module | Where | What it does |
|---|---|---|
| M1 CV parser | CVs tab | Browse or drop PDF, DOCX or TXT CVs. They are stored unparsed; parse one or all later. Parsing fills name, email, phone, location, LinkedIn, title, years, and an SFIA skill profile. Flags possible duplicates (same email or phone). |
| M2 WhatsApp send | WhatsApp button on a candidate or match | Message templates (intro, interest, interview, follow-up, close). Sends via the WhatsApp Business Cloud API, or opens WhatsApp with the message ready (wa.me) when the API isn't set up. |
| M3 WhatsApp tracker | WhatsApp tab | One conversation per candidate: status (New, Awaiting reply, Replied, Closed), next step with due date, linked role, "Next steps due" filter, unread badge. Close a chat with a reason to disable messaging; reopen any time. With the API, replies and delivery receipts arrive through the webhook; with wa.me, paste replies in with "Log their reply". |
| M4 Skills, matching, client card | Roles & matching tab | Paste a job description to build its SFIA skill profile (minimum level, must-have). Parsed candidates are ranked 0 to 100. Shortlist, then "Present to client" opens a printable card per candidate with the match table and an editable summary. Contact details are hidden by default. Print or save PDF, copy as text, or email. |

Parsing, role profiles and summaries use Claude through `/api/profiles` when deployed. Without it (preview mode, or the call fails) the page uses the built-in parser in `web/skills.js`, which is good for clean CVs and always editable.

## Files

```
web/recruiter.html   Page and styles (served at /modules/recruiter.html)
web/recruiter.js     App logic and storage
web/skills.js        SFIA catalogue, CV/JD heuristics, matching score (works in Node too)
web/samples.js       Three fictional CVs and a role for trying it out
functions/index.js   Cloud Functions: profiles, waSend, waWebhook
firestore.rules.additions   Rules to merge into ../firestore.rules
firebase.json.additions     Rewrites and functions codebase to merge into ../firebase.json
```

## Wire it into the app

1. The page lives in `public/modules/` (it loads `../firebase-config.js`).
2. Merge `firebase.json.additions` and `firestore.rules.additions` into the root files.
3. Add a link from `app.html` to `modules/recruiter.html`.

Data lives in Firestore at `users/{uid}/candidates`, `users/{uid}/roles` and `users/{uid}/conversations`. Until `firebase-config.js` has an `apiKey`, the page runs in preview mode and saves to the browser only.

## WhatsApp Business Cloud API

1. In Meta for Developers create an app with the WhatsApp product, add a business phone number, and create a permanent system-user token.
2. Create and get approval for a message template named `caplynk_outreach` with one body variable, e.g. `{{1}}`. WhatsApp only lets businesses start a conversation, or write after 24 hours of silence, with an approved template; CapLynk puts your message text in that variable.
3. Set the secrets and params:

```bash
firebase functions:secrets:set WA_TOKEN
firebase functions:secrets:set WA_APP_SECRET
firebase functions:secrets:set WA_VERIFY_TOKEN     # any string you choose
# in functions .env or at deploy prompt:
WA_PHONE_NUMBER_ID=123456789012345
WA_TEMPLATE=caplynk_outreach
WA_TEMPLATE_LANG=en
```

4. Deploy, then in Meta set the webhook URL to `https://<your-site>/api/whatsapp/webhook`, the verify token to `WA_VERIFY_TOKEN`, and subscribe to `messages`.
5. In CapLynk Settings choose "WhatsApp Business Cloud API".

## SFIA

`skills.js` carries a working subset of 41 SFIA 8 skills with keyword evidence. Levels use SFIA's 1 (Follow) to 7 (Set strategy). The match score gives each required skill credit up to its minimum level; must-haves count double. Add skills to `SFIA` and `KEYWORDS` in `skills.js` and to `SFIA_CODES` in `functions/index.js`.
