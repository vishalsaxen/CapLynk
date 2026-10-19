# CapLynk

CapLynk is a skills-based hiring platform from Gaplyn Services. It matches candidates to client roles using standard skill frameworks (such as SFIA) rather than keyword matching on CVs.

```
public/index.html      Candidate sign-up / sign-in (email + password with email verification, or Google)
public/app.html        Candidate home; signed-out or unverified visitors go back to index.html
public/applicant.html  Applicant Data: a candidate uploads their CV and sees its status
public/admin.html      Super Admin: every uploaded CV, parsing, WhatsApp contact, .txt conversation logs, roles and matching
public/admin.js        Super Admin workspace logic
public/modules/skills.js  SFIA catalogue, CV heuristics and matching score
public/assistant.html  CapLynk Assistant chat (Claude), no longer linked from the home page
modules/functions/     Cloud Functions: profiles (Claude parsing, Super Admin only), waSend, waWebhook
public/firebase-config.js  Your Firebase web config (shared by all pages)
functions/index.js     Cloud Function that calls the Claude API and streams the reply
firebase.json          Hosting + Functions + Firestore config
firestore.rules        Who can read and write what (see below)
storage.rules          Original CV files in Firebase Storage: the owner and the Super Admin only
```

## Accounts

The public site is for candidates only. They create an account with email and password and must open the verification link before they can sign in (Google accounts are already verified). Sign-up writes `users/{uid}` with `name`, `email` and `role: "candidate"`.

CVs a candidate uploads go to the top-level `cvs` collection with their `ownerUid`. The original PDF or Word file is kept in Firebase Storage at `cvs/{ownerUid}/{cvId}/{fileName}` (up to 10 MB), and the Super Admin can download it from admin.html. A candidate can read and add only their own, and can remove one until it has been reviewed.

The Super Admin is the single account `vaani.s@gaplyn.com`, signing in at `/admin.html`. Its password is kept in Firebase Authentication (create the user under Authentication → Users → Add user), never in page code, because this repository is public. The first sign-in emails a one-time verification link to that address. Only that verified account can read every CV and the `roles` and `conversations` collections, and only it can call Claude parsing.

## How the assistant fits together

Browser (Firebase Hosting) → `POST /api/chat` with the user's Firebase ID token → Cloud Function verifies the token → Claude API (key in Secret Manager) → reply streams back → chat saved to Firestore at `users/{uid}/chats/{chatId}`.

## Set up

1. Create a Firebase project at https://console.firebase.google.com (Blaze plan is needed for Functions that call external APIs).
2. Enable **Authentication → Google** and create a **Firestore** database.
3. Enable **Authentication → Email/Password**. Add a Web app and copy its config into `public/firebase-config.js`. Add the Super Admin user under **Authentication → Users → Add user**.
4. Put your project id in `.firebaserc`.
5. Install and deploy:

```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY   # paste your key from console.anthropic.com
firebase deploy
```

## Settings

| Param | Default | Meaning |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Any Claude model id, e.g. `claude-opus-5-5` for the most capable |
| `REQUIRE_AUTH` | `true` | Set `false` only for local emulator testing |

## Run locally

```bash
firebase emulators:start
```
Then open http://localhost:5000.
