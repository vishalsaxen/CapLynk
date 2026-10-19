# CapLynk recruiter workspace (modules 1 to 4)

One page, `web/recruiter.html`, with three tabs. It builds on the sign-in and app shell in `public/`.

| Module | Where | What it does |
|---|---|---|
| M1 CV parser | CVs tab | Browse or drop PDF, DOCX or TXT CVs. They are stored unparsed; parse one or all later. Parsing fills name, email, phone, location, LinkedIn, title, years, and a skill profile on the CapLynk Capability Taxonomy. Flags possible duplicates (same email or phone). |
| M2 WhatsApp send | WhatsApp button on a candidate or match | Message templates (intro, interest, interview, follow-up, close). Sends via the WhatsApp Business Cloud API, or opens WhatsApp with the message ready (wa.me) when the API isn't set up. |
| M3 WhatsApp tracker | WhatsApp tab | One conversation per candidate: status (New, Awaiting reply, Replied, Closed), next step with due date, linked role, "Next steps due" filter, unread badge. Close a chat with a reason to disable messaging; reopen any time. With the API, replies and delivery receipts arrive through the webhook; with wa.me, paste replies in with "Log their reply". |
| M4 Skills, matching, client card | Roles & matching tab | Paste a job description to build its skill profile from a taxonomy role and seniority band (minimum level, must-have). Parsed candidates are ranked 0 to 100. Shortlist, then "Present to client" opens a printable card per candidate with the match table and an editable summary. Contact details are hidden by default. Print or save PDF, copy as text, or email. |

Parsing, role profiles and summaries use Claude through `/api/profiles` when deployed. Without it (preview mode, or the call fails) the page uses the built-in parser in `web/skills.js`, which is good for clean CVs and always editable.

## Files

```
web/recruiter.html   Page and styles (served at /modules/recruiter.html)
web/recruiter.js     App logic and storage
web/skills.js        Taxonomy loader, CV/JD heuristics, matching score (works in Node too)
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

Until this is set up, admin.html uses wa.me click-to-chat (one candidate at a time). Once `waSend` reports the API is configured, admin.html sends from CapLynk, replies arrive in the tracker through the webhook, and **Bulk WhatsApp** (CVs tab, and "WhatsApp shortlist" on a role) is switched on.

Bulk messages only go to candidates who agreed: they tick the WhatsApp box on Applicant Data, or the admin records consent on their CV. A reply of STOP marks the candidate opted out (`conversations/{id}.optedOut`, `cvs/{id}.waConsent = false`) and CapLynk won't message them again unless consent is recorded again.

1. In Meta Business Suite create a WhatsApp Business account and add a business phone number (a number not already used on the WhatsApp app). In Meta for Developers create an app with the WhatsApp product, and create a System User with a permanent token that has `whatsapp_business_messaging` and `whatsapp_business_management`.
2. Create a message template named `caplynk_outreach`, category Marketing, language English, with one body variable and fixed text around it, for example: `Hello from Gaplyn Services. {{1}} Reply STOP to stop these messages.` CapLynk puts your message (one paragraph, up to 1,000 characters) into `{{1}}`. Wait for approval.
3. Set the secrets and params, then deploy the `modules` codebase:

```
firebase.cmd functions:secrets:set WA_TOKEN          # the permanent token
firebase.cmd functions:secrets:set WA_APP_SECRET     # App settings > Basic > App secret
firebase.cmd functions:secrets:set WA_VERIFY_TOKEN   # any string you choose
# modules/functions/.env (the deploy also asks):
WA_PHONE_NUMBER_ID=123456789012345
WA_TEMPLATE=caplynk_outreach
WA_TEMPLATE_LANG=en
```

4. In the Meta app's WhatsApp > Configuration set the callback URL to `https://<your-site>/api/whatsapp/webhook`, the verify token to `WA_VERIFY_TOKEN`, and subscribe to `messages`.

## Capability taxonomy

Skills, roles and levels come from the CapLynk Capability Taxonomy workbook, imported by the Super Admin in admin.html > Settings and stored in Firestore `taxonomy/{meta,skills,roles}` (Super Admin only; the workbook is not in this repo). Levels run L1 Aware to L6 Authority. A role's profile comes from the Role Skill Map at the chosen band (Junior 0-2 years, Mid 3-5, Senior 6-9, Lead 10+); Core skills are must-haves. The match score gives each required skill credit up to its minimum level; must-haves count double. The `profiles` function reads the same Firestore taxonomy, so Claude only uses its skill IDs.
