# CapLynk

CapLynk is a skills-based hiring platform from Gaplyn Services. It matches candidates to client roles using standard skill frameworks (such as SFIA) rather than keyword matching on CVs.

```
public/index.html      Create account / sign in (email + password, Google) — the entry to the site
public/app.html        Signed-in home; sends signed-out visitors back to index.html
public/assistant.html  CapLynk Assistant chat (Claude)
public/firebase-config.js  Your Firebase web config (shared by all pages)
functions/index.js     Cloud Function that calls the Claude API and streams the reply
firebase.json          Hosting + Functions + Firestore config (/api/chat → chat function)
firestore.rules        Each user can only read/write their own chats
```

## Accounts

People can sign in with email + password, Google, or a mobile number and 6-digit SMS code (OTP). Sign-up creates a Firebase Auth user plus a profile at `users/{uid}` with `name`, `email` and `role` (`candidate` or `employer`), and sends a verification email. Until `firebase-config.js` has an `apiKey`, pages run in preview mode and nothing is saved.

## How the assistant fits together

Browser (Firebase Hosting) → `POST /api/chat` with the user's Firebase ID token → Cloud Function verifies the token → Claude API (key in Secret Manager) → reply streams back → chat saved to Firestore at `users/{uid}/chats/{chatId}`.

## Set up

1. Create a Firebase project at https://console.firebase.google.com (Blaze plan is needed for Functions that call external APIs).
2. Enable **Authentication → Google** and create a **Firestore** database.
3. Enable **Authentication → Email/Password** and **Phone** too (Phone needs the Blaze plan to send real SMS; add test numbers under Phone → *Phone numbers for testing* to try it free). Add a Web app and copy its config into `public/firebase-config.js`.
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
