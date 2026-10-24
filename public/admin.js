// CapLynk Super Admin workspace.
// CVs: every CV candidates upload on applicant.html (top-level cvs/), parsed here (Claude via /api/profiles, or the offline heuristics).
// WhatsApp: Business Cloud API when it's set up (single and bulk sends, replies via webhook), otherwise wa.me click-to-chat;
//   each conversation is kept as a log that downloads as .txt. Bulk sends go only to candidates who agreed to WhatsApp messages.
// Tracker: per-candidate conversation with status, next step, due date, and close/reopen.
// Bulk Message for Roles: every candidate in a role's category with reply/consent filters, one bulk send, and the chats.
// Roles: skill profiles from the CapLynk Capability Taxonomy, ranked matches, and a printable client summary card.
// Taxonomy: imported from Gaplyn's Excel workbook in Settings and kept in Firestore taxonomy/{meta,skills,roles}.
// Storage: top-level Firestore collections cvs/, roles/, conversations/ that only the admin account can read (see firestore.rules).
(() => {
  const S = window.CapSkills;
  const $ = (id) => document.getElementById(id);
  const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => new Date().toISOString();
  const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const fmtDay = (d) => d ? new Date(d + "T00:00").toLocaleDateString([], { day: "numeric", month: "short" }) : "";
  const today = () => new Date().toISOString().slice(0, 10);

  const cfg = window.CAPLYNK_FIREBASE || {};
  const LIVE = !!cfg.apiKey;
  const LS_KEY = "caplynk.recruiter.v1", SET_KEY = "caplynk.recruiter.settings";
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const ADMIN_EMAIL = "vaani.s@gaplyn.com";
  const settings = Object.assign({ cc: "44", sender: "" }, lsGet(SET_KEY, {}), { waMode: "link" });
  const state = { candidates: [], roles: [], conversations: {}, tab: "cvs", candId: null, chatId: null, roleId: null, wf: "open", q: "",
    rbRoleId: null, rbFilter: "all", rbConsent: "any", rbQ: "", rbRoleQ: "", rbPerson: null, rbReply: "", rbBusy: false, rbProgress: "" };
  let fb = null; // { db, fs, user } in live mode

  // ---------- storage ----------
  const COLS = { candidates: "cvs", roles: "roles", conversations: "conversations" };
  function persistLocal() {
    if (LIVE) return;
    lsSet(LS_KEY, { candidates: state.candidates, roles: state.roles, conversations: state.conversations });
  }
  async function save(col, obj) {
    obj.updatedAt = now();
    if (col === "conversations") state.conversations[obj.id] = obj;
    else { const arr = state[col]; const i = arr.findIndex((x) => x.id === obj.id); if (i >= 0) arr[i] = obj; else arr.unshift(obj); }
    if (!LIVE) return persistLocal();
    try { await fb.fs.setDoc(fb.fs.doc(fb.db, COLS[col], obj.id), JSON.parse(JSON.stringify(obj))); }
    catch (e) { console.error(e); toast("Couldn't save to the cloud. Check your connection."); }
  }
  async function remove(col, id) {
    if (col === "conversations") delete state.conversations[id];
    else state[col] = state[col].filter((x) => x.id !== id);
    if (!LIVE) return persistLocal();
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, COLS[col], id)).catch(console.error);
  }

  async function api(path, body) {
    if (!LIVE || !fb?.user) throw new Error("offline");
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await fb.user.getIdToken()) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
    return res.json();
  }

  let toastTimer;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3800); }

  // ---------- tabs ----------
  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    ["cvs", "wa", "roles", "rb"].forEach((t) => ($("view-" + t).hidden = t !== tab));
    render();
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  function render() {
    renderUnread();
    if (state.tab === "cvs") renderCandidates();
    if (state.tab === "wa") renderChats();
    if (state.tab === "roles") renderRoles();
    if (state.tab === "rb") renderRoleBulk();
  }

  // =====================================================================
  // M1: CVs. Browse first, parse later.
  // =====================================================================
  const loadScript = (src) => new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const MAMMOTH = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";

  async function extractText(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext === "txt" || ext === "md") return file.text();
    if (ext === "pdf") {
      if (!window.pdfjsLib) { await loadScript(PDFJS + "pdf.min.js"); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; }
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let out = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const c = await (await pdf.getPage(p)).getTextContent();
        out += c.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
      }
      return out;
    }
    if (ext === "docx") {
      if (!window.mammoth) await loadScript(MAMMOTH);
      return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    }
    throw new Error("Use PDF, DOCX or TXT (" + file.name + ")");
  }

  async function addFiles(files) {
    let added = 0;
    for (const f of files) {
      try {
        const text = (await extractText(f)).replace(/[ \t]+\n/g, "\n").trim();
        if (!text) { toast(f.name + " has no readable text (scanned image?)"); continue; }
        const c = { id: uid(), status: "new", fileName: f.name, cvText: text.slice(0, 60000), addedAt: now(), name: "", skills: [],
          ownerUid: fb?.user?.uid || "", ownerEmail: fb?.user?.email || "", ownerName: "Uploaded by admin" };
        await storeOriginal(c, f);
        await save("candidates", c); added++;
        if (!state.candId) state.candId = c.id;
      } catch (e) { toast(e.message || "Couldn't read " + f.name); }
    }
    if (added) toast(added + (added === 1 ? " CV added. Parse it when you're ready." : " CVs added. Parse them when you're ready."));
    render();
  }
  // ---------- original CV files (Firebase Storage: cvs/{ownerUid}/{cvId}/{fileName}) ----------
  async function storeOriginal(c, file) {
    if (!LIVE || !fb?.st) return;
    const path = "cvs/" + fb.user.uid + "/" + c.id + "/" + file.name.replace(/[^\w.\- ]+/g, "_");
    try {
      await fb.st.uploadBytes(fb.st.ref(fb.bucket, path), file, { contentType: file.type || "application/octet-stream", contentDisposition: 'attachment; filename="' + file.name.replace(/"/g, "") + '"' });
      c.storagePath = path;
    } catch (e) { console.warn("Original file not stored", e); }
  }
  // Each CV downloads twice over: the file exactly as uploaded, and the text CapLynk read out of it.
  const fileKind = (c) => ({ pdf: "PDF", docx: "Word", doc: "Word", txt: "text", md: "text" })[(c.fileName || "").toLowerCase().split(".").pop()] || "file";
  async function downloadOriginal(c) {
    if (!c.storagePath || !fb?.st) return false;
    try {
      const a = document.createElement("a");
      // Stored with "Content-Disposition: attachment", so the link saves the file instead of leaving this page.
      a.href = await fb.st.getDownloadURL(fb.st.ref(fb.bucket, c.storagePath));
      a.click(); return true;
    } catch (e) { console.error(e); toast("Couldn't fetch the original " + (c.fileName || "file") + "."); return false; }
  }
  const downloadText = (c) => download((c.fileName || candLabel(c)).replace(/\.[a-z0-9]+$/i, "") + ".txt", c.cvText || "");
  const pause = () => new Promise((ok) => setTimeout(ok, 700));

  $("allCvsBtn").onclick = async () => {
    if (!state.candidates.length) return toast("No CVs to download yet.");
    toast("Downloading " + state.candidates.length + " CVs with their .txt copies. If the browser asks, allow multiple downloads.");
    for (const c of state.candidates) {
      if (await downloadOriginal(c)) await pause();
      downloadText(c); await pause();
    }
  };

  $("cvFiles").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  $("candSearch").oninput = (e) => { state.q = e.target.value.toLowerCase(); renderCandidates(); };

  async function parseCandidate(c, quiet) {
    let p, by = "heuristic";
    try { p = (await api("/api/profiles", { action: "cv", text: c.cvText })).profile; by = "claude"; }
    catch (e) { if (LIVE && !quiet) toast("Claude parse unavailable, used the built-in parser."); p = S.parseCvText(c.cvText, c.fileName); }
    const valid = (p.skills || []).filter((s) => S.BY_CODE[s.code]).map((s) => ({ code: s.code, level: clampLevel(s.level), evidence: s.evidence || "" }));
    Object.assign(c, {
      // The name a candidate signed up with beats the offline parser's guess; Claude reads the CV properly.
      name: (by === "claude" ? p.name || accountName(c) : accountName(c) || p.name) || c.name || "", email: p.email || c.email || accountEmail(c), phone: p.phone || c.waPhone || "", location: p.location || "",
      linkedin: p.linkedin || "", headline: p.headline || "", yearsExperience: p.yearsExperience ?? null,
      summary: p.summary || c.summary || "", skills: valid, status: "parsed", parsedAt: now(), parsedBy: by,
    });
    await save("candidates", c);
  }

  $("parseAllBtn").onclick = async () => {
    const todo = state.candidates.filter((c) => c.status === "new");
    if (!todo.length) return toast("No new CVs to parse.");
    for (const c of todo) await parseCandidate(c, true);
    toast("Parsed " + todo.length + (todo.length === 1 ? " CV." : " CVs."));
    render();
  };

  // The candidate's own account details, for CVs they uploaded themselves.
  const accountName = (c) => (c.ownerName && c.ownerName !== "Uploaded by admin" ? c.ownerName : "");
  const accountEmail = (c) => (c.ownerName === "Uploaded by admin" ? "" : c.ownerEmail || "");
  function candLabel(c) { return c.name || accountName(c) || c.fileName || "Unnamed candidate"; }
  function duplicateOf(c) {
    const d = (v) => String(v || "").replace(/\D/g, "").slice(-9);
    return state.candidates.find((o) => o.id !== c.id && ((c.email && o.email && o.email.toLowerCase() === c.email.toLowerCase()) || (c.phone && o.phone && d(o.phone) === d(c.phone))));
  }

  function renderCandidates() {
    const q = state.q;
    const list = state.candidates.filter((c) => !q || [c.name, c.fileName, c.email, c.ownerName, c.ownerEmail, c.headline, ...(c.skills || []).map((s) => s.code + " " + (S.BY_CODE[s.code]?.name || ""))].join(" ").toLowerCase().includes(q));
    $("candList").innerHTML = list.length ? list.map((c) => `
      <li><button data-id="${c.id}" aria-current="${c.id === state.candId}">
        <span class="li-top"><span>${h(candLabel(c))}</span>${c.status === "new" ? '<span class="chip amber">Not parsed</span>' : '<span class="chip green">Parsed</span>'}</span>
        <span class="li-sub">${h(c.status === "new" ? [accountEmail(c), fmtTime(c.addedAt)].filter(Boolean).join(" · ") || c.fileName : [c.headline, c.location].filter(Boolean).join(" · ") || c.email || "")}</span>
      </button></li>`).join("") : `<li class="muted" style="padding:14px">${state.candidates.length ? "No matches." : "No CVs yet."}</li>`;
    $("candList").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.candId = b.dataset.id; renderCandidates(); }));

    const c = state.candidates.find((x) => x.id === state.candId);
    const drop = `<div class="drop" id="drop"><strong>Drop CVs here</strong> or use <em>Browse CVs</em> to add one yourself. Candidates' own uploads from Applicant Data appear in the list on their own.</div>`;
    if (!c) {
      $("candDetail").innerHTML = drop + `<div class="empty"><h3>No CVs yet</h3><p>CVs that candidates upload under Applicant Data show up here. Parse them to pull out contact details and a skill profile from the CapLynk Capability Taxonomy, then contact the candidate on WhatsApp.</p></div>`;
      return wireDrop();
    }
    const dup = duplicateOf(c);
    const conv = state.conversations[c.id];
    $("candDetail").innerHTML = drop + `
      <div class="title-row">
        <div><h1>${h(candLabel(c))}</h1><div class="sub">${h(c.fileName || "")}${c.ownerEmail && accountEmail(c) ? " · uploaded by " + h(accountEmail(c)) + " " + fmtTime(c.addedAt) : ""}${c.parsedBy ? " · parsed " + (c.parsedBy === "claude" ? "by Claude" : "by built-in parser") + " " + fmtTime(c.parsedAt) : ""}</div></div>
        <div class="row">
          <button class="btn ${c.status === "new" ? "" : "ghost"}" id="parseBtn" type="button">${c.status === "new" ? "Parse CV" : "Parse again"}</button>
          <button class="btn wa" id="waBtn" type="button" ${c.phone || c.waPhone ? "" : "disabled title='Add a phone number first'"}>WhatsApp${conv ? (conv.status === "closed" ? " (closed)" : "") : ""}</button>
          ${c.storagePath ? `<button class="btn ghost" id="cvDlBtn" type="button" title="The file exactly as it was uploaded">Download ${fileKind(c)}</button>`
            : `<label class="btn ghost" for="attachFile" title="This CV arrived before original files were kept. Attach the PDF or Word file to store it with the CV.">Attach original</label><input id="attachFile" type="file" accept=".pdf,.doc,.docx,.txt,.md" hidden>`}
          <button class="btn ghost" id="txtDlBtn" type="button" title="The text CapLynk read from the CV">Download .txt</button>
          <button class="btn danger" id="delBtn" type="button">Delete</button>
        </div>
      </div>
      <div class="row" style="margin:-4px 0 12px">${consentChip(c)}
        <button class="btn ghost sm" id="consentBtn" type="button">${c.waConsent ? "Remove WhatsApp consent" : "Record WhatsApp consent"}</button></div>
      ${c.status === "new" ? '<div class="warn">Not parsed yet. Parse to fill in contact details and skills, or type them in yourself.</div>' : ""}
      ${oldSkills(c.skills) ? '<div class="warn">This profile still uses old SFIA skills. Click Parse again to rebuild it on the CapLynk Capability Taxonomy.</div>' : ""}
      ${dup ? `<div class="warn">Possible duplicate of <a href="#" id="dupLink">${h(candLabel(dup))}</a> (same email or phone).</div>` : ""}
      <div class="card"><h3>Personal and contact details</h3>
        <div class="grid">
          ${field("name", "Full name", c.name)}${field("email", "Email", c.email, "email")}${field("phone", "Phone (WhatsApp)", c.phone, "tel")}
          ${field("location", "Location", c.location)}${field("headline", "Current title", c.headline)}${field("yearsExperience", "Years of experience", c.yearsExperience ?? "", "number")}
          ${field("linkedin", "LinkedIn", c.linkedin)}${field("notice", "Notice period", c.notice)}${field("salary", "Salary expectation", c.salary)}
        </div>
        <label class="f" style="margin-top:12px">Recruiter summary
          <textarea data-f="summary" rows="3" placeholder="A few lines on this candidate, used on the client card.">${h(c.summary)}</textarea></label>
      </div>
      <div class="card"><h3>Skill profile <button class="btn ghost sm" id="addSkillBtn" type="button">Add skill</button></h3>
        ${skillTable(c.skills, "cand")}
      </div>
      <div class="card"><h3>CV text</h3><details><summary class="muted">Show the extracted text</summary><pre class="cv">${h(c.cvText)}</pre></details></div>`;
    wireDrop();
    $("candDetail").querySelectorAll("[data-f]").forEach((el) => (el.onchange = () => {
      c[el.dataset.f] = el.type === "number" ? (el.value === "" ? null : +el.value) : el.value.trim();
      save("candidates", c); renderCandidates();
    }));
    wireSkillTable(c.skills, () => save("candidates", c), "cand");
    $("addSkillBtn").onclick = () => { c.skills.push({ code: unusedCode(c.skills), level: 3, evidence: "" }); save("candidates", c); renderCandidates(); };
    $("parseBtn").onclick = async () => { $("parseBtn").disabled = true; $("parseBtn").textContent = "Parsing…"; await parseCandidate(c); renderCandidates(); };
    $("waBtn").onclick = () => openChat(c.id);
    $("consentBtn").onclick = () => toggleConsent(c, renderCandidates);
    if ($("cvDlBtn")) $("cvDlBtn").onclick = () => downloadOriginal(c);
    $("txtDlBtn").onclick = () => downloadText(c);
    if ($("attachFile")) $("attachFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      await storeOriginal(c, f);
      if (!c.storagePath) return toast("Couldn't store " + f.name + ". Check that Firebase Storage is set up.");
      c.originalAttachedAt = now();
      await save("candidates", c); renderCandidates(); toast(f.name + " is now stored with this CV.");
    };
    $("delBtn").onclick = async () => { if (!confirm("Delete " + candLabel(c) + " and their WhatsApp history?")) return; await remove("candidates", c.id);
      if (c.storagePath && fb?.st) fb.st.deleteObject(fb.st.ref(fb.bucket, c.storagePath)).catch(console.error); if (conv) await remove("conversations", c.id); state.candId = state.candidates[0]?.id || null; render(); };
    if (dup) $("dupLink").onclick = (e) => { e.preventDefault(); state.candId = dup.id; renderCandidates(); };
  }
  function toggleConsent(c, after) {
    if (c.waConsent) { c.waConsent = false; c.waConsentAt = ""; }
    else {
      if (!confirm("Only record consent if " + candLabel(c) + " has agreed to WhatsApp messages from Gaplyn Services, in writing or on a call. Record it now?")) return;
      c.waConsent = true; c.waConsentAt = now(); c.waConsentBy = "admin"; delete c.waOptOutAt;
      const conv = state.conversations[c.id]; if (conv?.optedOut) { conv.optedOut = false; save("conversations", conv); }
    }
    save("candidates", c); after();
  }
  function consentChip(c) {
    if (state.conversations[c.id]?.optedOut || (c.waOptOutAt && !c.waConsent)) return '<span class="chip magenta">WhatsApp: opted out</span>';
    if (c.waConsent) return `<span class="chip green" title="${c.waConsentBy === "admin" ? "Recorded by the admin" : "Ticked on Applicant Data"} ${h(fmtTime(c.waConsentAt))}">WhatsApp: agreed</span>`;
    return '<span class="chip amber" title="Bulk messages skip this candidate">WhatsApp: no consent yet</span>';
  }
  function field(key, label, val, type = "text") { return `<label class="f">${label}<input data-f="${key}" type="${type}" value="${h(val ?? "")}"></label>`; }
  const clampLevel = (v) => Math.max(1, Math.min(S.LEVELS.length - 1 || 6, +v || 3));
  const oldSkills = (list) => (list || []).some((x) => !S.BY_CODE[x.code]);
  function unusedCode(list) { const used = new Set(list.map((s) => s.code)); return (S.SKILLS.find((s) => !used.has(s.code)) || S.SKILLS[0])?.code || ""; }
  // Grouped by domain and category, as in the taxonomy's Skills sheet. Codes from before the taxonomy stay visible as "old".
  let optionCache = "";
  function skillOptions(sel) {
    if (!optionCache) {
      let grp = "";
      for (const s of S.SKILLS) {
        const g = s.domain + " · " + s.category;
        if (g !== grp) { optionCache += (grp ? "</optgroup>" : "") + `<optgroup label="${h(g)}">`; grp = g; }
        optionCache += `<option value="${h(s.code)}">${h(s.name)} (${h(s.code)})</option>`;
      }
      if (grp) optionCache += "</optgroup>";
    }
    const old = sel && !S.BY_CODE[sel] ? `<option value="${h(sel)}">Old SFIA skill: ${h(sel)}</option>` : "";
    return old + optionCache.replace(`value="${h(sel)}"`, `value="${h(sel)}" selected`);
  }
  function levelOptions(sel) { return S.LEVELS.slice(1).map((l, i) => `<option value="${i + 1}" ${+sel === i + 1 ? "selected" : ""}>${h(l)}</option>`).join(""); }
  function skillTable(list, kind) {
    if (!list.length) return `<p class="muted" style="margin:0">No skills yet. Parse the ${kind === "cand" ? "CV" : "description"} or add them yourself.</p>`;
    return `<table><thead><tr><th>Skill</th><th>${kind === "cand" ? "Level" : "Minimum level"}</th><th>${kind === "cand" ? "Evidence" : "Must have"}</th><th></th></tr></thead><tbody>
      ${list.map((s, i) => `<tr data-i="${i}">
        <td><select data-k="code">${skillOptions(s.code)}</select></td>
        <td><select data-k="${kind === "cand" ? "level" : "minLevel"}">${levelOptions(kind === "cand" ? s.level : s.minLevel)}</select></td>
        <td>${kind === "cand" ? `<input class="in" data-k="evidence" value="${h(s.evidence)}" style="width:100%">` : `<input type="checkbox" data-k="mustHave" ${s.mustHave ? "checked" : ""}>`}</td>
        <td><button class="btn ghost sm" data-del type="button" aria-label="Remove">✕</button></td></tr>`).join("")}
      </tbody></table>`;
  }
  function wireSkillTable(list, onSave, kind) {
    const root = kind === "cand" ? $("candDetail") : $("roleDetail");
    root.querySelectorAll("tr[data-i]").forEach((tr) => {
      const s = list[+tr.dataset.i];
      tr.querySelectorAll("[data-k]").forEach((el) => (el.onchange = () => {
        const k = el.dataset.k;
        s[k] = k === "mustHave" ? el.checked : (k === "level" || k === "minLevel") ? +el.value : el.value;
        onSave(); if (kind === "role") renderRoles();
      }));
      tr.querySelector("[data-del]").onclick = () => { list.splice(+tr.dataset.i, 1); onSave(); render(); };
    });
  }
  function wireDrop() {
    const d = $("drop"); if (!d) return;
    d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); addFiles([...e.dataTransfer.files]); };
  }

  // =====================================================================
  // M2 + M3: WhatsApp send and conversation tracker
  // =====================================================================
  const TEMPLATES = [
    ["intro", "Introduce a role", "Hi {first}, this is {sender}. I came across your profile and have {a_role} opportunity that looks like a strong match for your skills. Are you open to a quick chat this week?"],
    ["interest", "Check interest and availability", "Hi {first}, are you currently open to new roles? If so, what notice period and salary range should I note for {role}?"],
    ["interview", "Invite to interview", "Hi {first}, good news: the client would like to interview you for {role}. Which of these times works for you?\n1. \n2. "],
    ["followup", "Follow up", "Hi {first}, just following up on my last message about {role}. Let me know either way when you have a moment."],
    ["close", "Close politely", "Thanks for your time, {first}. I'll close this conversation for now and will be in touch if something else fits."],
  ];
  const CLOSE_REASONS = ["Placed", "Not interested", "No response", "Not a fit", "Hired elsewhere", "Other"];

  function ensureConv(candId) {
    let conv = state.conversations[candId];
    if (!conv) { conv = { id: candId, candidateId: candId, status: "open", messages: [], nextStep: "", nextStepDue: "", roleId: "", createdAt: now() }; state.conversations[candId] = conv; }
    return conv;
  }
  // A conversation belongs to a CV, or to a contact messaged from an Excel sheet (conversations/xl-<number>).
  function convPerson(conv) {
    const c = state.candidates.find((x) => x.id === conv.id);
    if (c || !String(conv.id).startsWith("xl-")) return c || null;
    return { id: conv.id, name: conv.contactName || "+" + conv.phone, phone: "+" + conv.phone, contact: true };
  }
  function openChat(candId) { ensureConv(candId); state.chatId = candId; state.wf = state.conversations[candId].status === "closed" ? "closed" : "open"; setTab("wa"); }

  function convState(conv) {
    if (conv.status === "closed") return ["Closed", "magenta"];
    const last = conv.messages[conv.messages.length - 1];
    if (!last) return ["New", ""];
    return last.dir === "in" ? ["Replied", "green"] : ["Awaiting reply", "amber"];
  }
  function renderUnread() {
    const n = Object.values(state.conversations).filter((c) => c.unread).length;
    $("unreadCount").hidden = !n; $("unreadCount").textContent = n;
    const r = rbUnreadTotal(); $("rbUnread").hidden = !r; $("rbUnread").textContent = r;
  }

  document.querySelectorAll("[data-wf]").forEach((b) => (b.onclick = () => { state.wf = b.dataset.wf; renderChats(); }));

  function renderChats() {
    document.querySelectorAll("[data-wf]").forEach((b) => b.classList.toggle("ghost", b.dataset.wf !== state.wf));
    const t = today();
    const convs = Object.values(state.conversations)
      .filter((c) => convPerson(c))
      .filter((c) => state.wf === "all" || (state.wf === "closed" ? c.status === "closed" : c.status !== "closed") && (state.wf !== "next" || (c.nextStepDue && c.nextStepDue <= t)))
      .sort((a, b) => (b.lastAt || b.createdAt || "").localeCompare(a.lastAt || a.createdAt || ""));
    $("chatList").innerHTML = convs.length ? convs.map((conv) => {
      const c = convPerson(conv);
      const [label, tone] = convState(conv);
      const last = conv.messages[conv.messages.length - 1];
      const due = conv.nextStepDue ? ` · <span class="${conv.nextStepDue <= t && conv.status !== "closed" ? "overdue" : ""}">due ${fmtDay(conv.nextStepDue)}</span>` : "";
      return `<li><button data-id="${conv.id}" aria-current="${conv.id === state.chatId}">
        <span class="li-top"><span>${conv.unread ? '<span class="dot"></span> ' : ""}${h(candLabel(c))}</span><span class="chip ${tone}">${label}</span></span>
        <span class="li-sub">${conv.nextStep ? "Next: " + h(conv.nextStep) + due : h(last ? (last.dir === "in" ? "" : "You: ") + last.text : "No messages yet")}</span>
      </button></li>`;
    }).join("") : `<li class="muted" style="padding:14px">${state.wf === "closed" ? "No closed chats." : state.wf === "next" ? "No next steps due today or earlier." : "No conversations. Use the WhatsApp button on a candidate to start one."}</li>`;
    $("chatList").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.chatId = b.dataset.id; renderChats(); }));

    const conv = state.conversations[state.chatId];
    const c = conv && convPerson(conv);
    if (!conv || !c) { $("chatDetail").innerHTML = `<div class="empty"><h3>WhatsApp tracker</h3><p>Every message you send to a candidate lands here with its replies, a next step and a due date. Close a chat when it's no longer needed; closed chats can't be messaged until you reopen them.</p></div>`; return; }
    if (conv.unread) { conv.unread = false; save("conversations", conv); renderUnread(); }

    const phone = S.toE164Digits(c.phone || c.waPhone, settings.cc);
    const closed = conv.status === "closed";
    const [label, tone] = convState(conv);
    const role = state.roles.find((r) => r.id === conv.roleId);
    $("chatDetail").innerHTML = `
      <div class="chat-head">
        <div class="title-row" style="margin:0">
          <div><h1 style="font-size:21px">${h(candLabel(c))} <span class="chip ${tone}" style="vertical-align:middle">${label}</span></h1>
            <div class="sub">${phone ? "+" + h(phone) : "No phone number"} · ${settings.waMode === "api" ? "Business API" : "WhatsApp link"}</div></div>
          <div class="row">
            ${c.contact ? "" : `<button class="btn ghost sm" id="viewCandBtn" type="button">View CV</button>`}
            <button class="btn ghost sm" id="logBtn" type="button">Download log (.txt)</button>
            ${closed ? `<button class="btn sm" id="reopenBtn" type="button">Reopen chat</button>` :
              `<select class="in" id="closeReason" aria-label="Close reason">${CLOSE_REASONS.map((r) => `<option>${r}</option>`).join("")}</select><button class="btn danger sm" id="closeChatBtn" type="button">Close chat</button>`}
          </div>
        </div>
        <div class="grid" style="grid-template-columns: minmax(180px,2fr) minmax(140px,1fr) minmax(160px,1fr)">
          <label class="f">Next step<input id="nextStep" value="${h(conv.nextStep)}" placeholder="e.g. Call to confirm availability" ${closed ? "disabled" : ""}></label>
          <label class="f">Due<input id="nextDue" type="date" value="${h(conv.nextStepDue)}" ${closed ? "disabled" : ""}></label>
          <label class="f">About role<select id="convRole" ${closed ? "disabled" : ""}><option value="">No role</option>${state.roles.map((r) => `<option value="${r.id}" ${r.id === conv.roleId ? "selected" : ""}>${h(r.title)}${r.client ? " · " + h(r.client) : ""}</option>`).join("")}</select></label>
        </div>
      </div>
      <div class="msgs" id="msgs">
        <div class="sys">Conversation started ${fmtTime(conv.createdAt)}</div>
        ${conv.messages.map((m) => m.dir === "sys" ? `<div class="sys">${h(m.text)} · ${fmtTime(m.at)}</div>` : `
          <div class="msg ${m.dir}">${h(m.text)}<div class="meta">${fmtTime(m.at)}${m.dir === "out" ? " · " + h(m.status || (m.via === "link" ? "opened in WhatsApp" : "sent")) + (m.error ? ": " + h(m.error) : "") : m.via === "manual" ? " · logged" : ""}</div></div>`).join("")}
      </div>
      <div class="composer">
        ${closed ? `<div class="closed-note"><span>Chat closed${conv.closeReason ? " (" + h(conv.closeReason) + ")" : ""} on ${fmtTime(conv.closedAt)}. Messaging is disabled.</span></div>` : `
        <div class="row">
          <select class="in" id="tpl" aria-label="Message template"><option value="">Write your own…</option>${TEMPLATES.map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
          <span class="muted" style="font-size:12.5px">${settings.waMode === "api" ? "Outside 24 hours of their last reply, WhatsApp only allows approved templates; CapLynk sends your text through the outreach template." : "Opens WhatsApp with the message ready; press send there."}</span>
        </div>
        <textarea id="msgText" placeholder="Message to ${h(first(c.name))}"></textarea>
        <div class="row" style="justify-content:space-between">
          <button class="btn ghost sm" id="logReplyBtn" type="button" title="Paste what the candidate replied">Log their reply</button>
          <button class="btn wa" id="sendBtn" type="button" ${phone ? "" : "disabled"}>Send on WhatsApp</button>
        </div>`}
      </div>`;
    const msgs = $("msgs"); msgs.scrollTop = msgs.scrollHeight;
    if (!c.contact) $("viewCandBtn").onclick = () => { state.candId = c.id; setTab("cvs"); };
    $("logBtn").onclick = () => download(logFileName(c), convLog(conv, c));
    if (closed) {
      $("reopenBtn").onclick = () => { conv.status = "open"; conv.messages.push({ dir: "sys", text: "Chat reopened", at: now() }); save("conversations", conv); state.wf = "open"; renderChats(); };
      return;
    }
    $("closeChatBtn").onclick = () => {
      conv.status = "closed"; conv.closedAt = now(); conv.closeReason = $("closeReason").value; conv.nextStepDue = "";
      conv.messages.push({ dir: "sys", text: "Chat closed: " + conv.closeReason, at: now() });
      save("conversations", conv); state.wf = "closed"; renderChats(); toast("Chat closed. Reopen it any time from Closed.");
    };
    $("nextStep").onchange = (e) => { conv.nextStep = e.target.value.trim(); save("conversations", conv); renderChats(); };
    $("nextDue").onchange = (e) => { conv.nextStepDue = e.target.value; save("conversations", conv); renderChats(); };
    $("convRole").onchange = (e) => { conv.roleId = e.target.value; save("conversations", conv); };
    $("tpl").onchange = (e) => {
      const t = TEMPLATES.find(([k]) => k === e.target.value); if (!t) return;
      $("msgText").value = t[2].replace(/\{first\}/g, first(c.name)).replace(/\{sender\}/g, settings.sender || "the CapLynk team at Gaplyn Services")
        .replace(/\{a_role\}/g, role ? (/^[aeiou]/i.test(role.title) ? "an " : "a ") + role.title : "a new")
        .replace(/\{role\}/g, role ? role.title : "the role"); $("msgText").focus();
    };
    $("logReplyBtn").onclick = () => {
      const text = $("msgText").value.trim(); if (!text) return toast("Paste the candidate's reply in the box first.");
      conv.messages.push({ id: uid(), dir: "in", text, at: now(), via: "manual" }); conv.lastAt = now();
      save("conversations", conv); renderChats();
    };
    $("sendBtn").onclick = () => sendWhatsApp(conv, c, phone, $("msgText").value.trim(), $("sendBtn"), renderChats);
  }

  // ---------- conversation logs (.txt) ----------
  const stamp = (iso) => iso ? new Date(iso).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  function convLog(conv, c) {
    const role = state.roles.find((r) => r.id === conv.roleId);
    const head = [
      "CapLynk WhatsApp log",
      "Candidate: " + candLabel(c),
      "Phone: " + (c.phone || "none"),
      "Email: " + (c.email || accountEmail(c) || "none"),
      role ? "Role: " + role.title + (role.client ? " (" + role.client + ")" : "") : "",
      "Status: " + convState(conv)[0] + (conv.closeReason ? " (" + conv.closeReason + ")" : ""),
      conv.nextStep ? "Next step: " + conv.nextStep + (conv.nextStepDue ? ", due " + conv.nextStepDue : "") : "",
      "Started: " + stamp(conv.createdAt),
      "Exported: " + stamp(now()),
    ].filter(Boolean);
    const who = { out: "CapLynk", in: first(candLabel(c)), sys: "Note" };
    const lines = conv.messages.map((m) => `[${stamp(m.at)}] ${who[m.dir] || m.dir}: ${m.text}` +
      (m.dir === "out" && m.status ? ` (${m.status}${m.error ? ": " + m.error : ""})` : m.via === "manual" ? " (logged by admin)" : ""));
    return head.join("\n") + "\n" + "-".repeat(40) + "\n" + (lines.join("\n") || "No messages yet.") + "\n";
  }
  const logFileName = (c) => "caplynk-whatsapp-" + candLabel(c).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".txt";
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $("allLogsBtn").onclick = () => {
    const convs = Object.values(state.conversations).filter((cv) => state.candidates.some((x) => x.id === cv.id));
    if (!convs.length) return toast("No conversations to download yet.");
    const text = convs.map((cv) => convLog(cv, state.candidates.find((x) => x.id === cv.id))).join("\n" + "=".repeat(40) + "\n\n");
    download("caplynk-whatsapp-logs-" + today() + ".txt", text);
  };

  // Free text only reaches someone who wrote to us in the last 24 hours; otherwise WhatsApp needs the approved template.
  function inWindow(conv) {
    const lastIn = [...(conv?.messages || [])].reverse().find((m) => m.dir === "in");
    return !!lastIn && Date.now() - new Date(lastIn.at).getTime() < 24 * 3600e3;
  }
  async function sendWhatsApp(conv, c, phone, text, btn, after) {
    if (!text) return toast("Write a message first.");
    if (conv.status === "closed") return toast("This chat is closed. Reopen it to send.");
    if (conv.optedOut) return toast(first(c.name) + " replied STOP, so CapLynk won't message them. Record consent again on their CV if they opt back in.");
    btn.disabled = true;
    if (settings.waMode === "api") {
      try {
        const r = await api("/api/whatsapp/send", { candidateId: c.id, to: phone, text, useTemplate: !inWindow(conv), candidateName: c.name || "", roleId: conv.roleId || "" });
        conv.messages.push({ id: r.messageId || uid(), dir: "out", text, at: now(), via: "api", status: "sent" }); conv.lastAt = now();
        state.conversations[conv.id] = conv; // the server stores the message; the live listener refreshes it
        after(); return toast("Sent on WhatsApp.");
      } catch (e) {
        toast("Business API unavailable (" + (e.message || "error").slice(0, 80) + "). Opening WhatsApp instead.");
      }
    }
    window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(text), "_blank", "noopener");
    conv.messages.push({ id: uid(), dir: "out", text, at: now(), via: "link", status: "opened in WhatsApp" }); conv.lastAt = now();
    await save("conversations", conv); after();
  }

  // ---------- bulk WhatsApp (Business API only, consented candidates only) ----------
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  function bulkBlock(c) {
    const conv = state.conversations[c.id];
    if (!S.toE164Digits(c.phone || c.waPhone, settings.cc)) return "no phone number";
    if (conv?.optedOut || (c.waOptOutAt && !c.waConsent)) return "opted out";
    if (!c.waConsent) return "no WhatsApp consent";
    if (conv?.status === "closed") return "chat closed";
    return "";
  }
  function fillMessage(raw, c, role) {
    return raw.replace(/\{first\}/g, first(c.name)).replace(/\{sender\}/g, settings.sender || "the CapLynk team at Gaplyn Services")
      .replace(/\{a_role\}/g, role ? (/^[aeiou]/i.test(role.title) ? "an " : "a ") + role.title : "a new")
      .replace(/\{role\}/g, role ? role.title : "the role");
  }
  let bulkPick = new Set(), bulkBusy = false;
  function openBulk({ ids = [], roleId = "" } = {}) {
    bulkPick = new Set(ids.filter((id) => { const c = state.candidates.find((x) => x.id === id); return c && !bulkBlock(c); }));
    $("bulkTpl").innerHTML = '<option value="">Write your own…</option>' + TEMPLATES.filter(([k]) => k !== "close").map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
    $("bulkRole").innerHTML = '<option value="">No role</option>' + state.roles.map((r) => `<option value="${r.id}" ${r.id === roleId ? "selected" : ""}>${h(r.title)}${r.client ? " · " + h(r.client) : ""}</option>`).join("");
    if (!$("bulkText").value) { $("bulkTpl").value = "intro"; $("bulkTpl").onchange(); }
    $("bulkProgress").textContent = "";
    $("bulkNote").hidden = settings.waMode === "api";
    $("bulkNote").textContent = LIVE ? "Bulk sending needs the WhatsApp Business API, which isn't set up yet. You can still pick recipients and draft the message; until then, message candidates one at a time from their CV." : "Preview mode: bulk sending works once CapLynk is live with the WhatsApp Business API.";
    renderBulk(); $("bulkDlg").showModal();
  }
  function renderBulk() {
    const roleId = $("bulkRole").value;
    const role = state.roles.find((r) => r.id === roleId);
    const people = [...state.candidates].sort((a, b) => (+!!bulkBlock(a) - +!!bulkBlock(b)) || (role?.shortlist?.includes(b.id) - role?.shortlist?.includes(a.id)) || candLabel(a).localeCompare(candLabel(b)));
    $("bulkList").innerHTML = people.length ? people.map((c) => {
      const why = bulkBlock(c);
      return `<li><label class="${why ? "off" : ""}"><input type="checkbox" data-bulk="${c.id}" ${bulkPick.has(c.id) ? "checked" : ""} ${why ? "disabled" : ""}>
        <span><strong>${h(candLabel(c))}</strong> <span class="muted">${h([c.headline, why ? "" : "+" + S.toE164Digits(c.phone || c.waPhone, settings.cc)].filter(Boolean).join(" · "))}</span></span>
        ${why ? `<span class="chip ${why === "opted out" ? "magenta" : "amber"}">${why}</span>` : role?.shortlist?.includes(c.id) ? '<span class="chip green">shortlisted</span>' : ""}</label></li>`;
    }).join("") : '<li class="muted" style="padding:12px">No candidates yet.</li>';
    $("bulkList").querySelectorAll("[data-bulk]").forEach((el) => (el.onchange = () => { el.checked ? bulkPick.add(el.dataset.bulk) : bulkPick.delete(el.dataset.bulk); bulkCount(); }));
    bulkCount();
  }
  function bulkCount() {
    const n = bulkPick.size, eligible = state.candidates.filter((c) => !bulkBlock(c)).length;
    $("bulkCount").textContent = `${n} selected · ${eligible} of ${state.candidates.length} can receive bulk messages`;
    $("bulkSendBtn").textContent = n ? `Send to ${n}` : "Send";
    $("bulkSendBtn").disabled = !n || bulkBusy || settings.waMode !== "api";
  }
  $("bulkBtn").onclick = () => openBulk();
  $("closeBulkBtn").onclick = () => { if (!bulkBusy) $("bulkDlg").close(); };
  $("bulkDlg").oncancel = (e) => { if (bulkBusy) e.preventDefault(); };
  $("bulkRole").onchange = () => renderBulk();
  $("bulkTpl").onchange = () => {
    const t = TEMPLATES.find(([k]) => k === $("bulkTpl").value); if (!t) return;
    $("bulkText").value = t[2].replace(/\n[\s\S]*$/, "").replace(/\{sender\}/g, settings.sender || "the CapLynk team at Gaplyn Services");
  };
  $("bulkAllBtn").onclick = () => { state.candidates.forEach((c) => { if (!bulkBlock(c)) bulkPick.add(c.id); }); renderBulk(); };
  $("bulkSendBtn").onclick = async () => {
    const raw = $("bulkText").value.trim();
    if (!raw) return toast("Write the message first.");
    const role = state.roles.find((r) => r.id === $("bulkRole").value);
    const targets = state.candidates.filter((c) => bulkPick.has(c.id) && !bulkBlock(c));
    if (!confirm(`Send this WhatsApp message to ${targets.length} candidate${targets.length === 1 ? "" : "s"}? Each is sent through your approved template and logged in the tracker.`)) return;
    bulkBusy = true; bulkCount();
    let sent = 0; const failed = [];
    for (const c of targets) {
      $("bulkProgress").textContent = `Sending ${sent + failed.length + 1} of ${targets.length}…`;
      try {
        await api("/api/whatsapp/send", { candidateId: c.id, to: S.toE164Digits(c.phone || c.waPhone, settings.cc), text: fillMessage(raw, c, role), useTemplate: true, roleId: role?.id || "" });
        sent++; bulkPick.delete(c.id);
      } catch (e) { failed.push(candLabel(c) + ": " + String(e.message || "error").slice(0, 120)); }
      await sleep(250); // stays well inside WhatsApp's per-second limit
    }
    bulkBusy = false; renderBulk();
    $("bulkProgress").textContent = `Sent ${sent} of ${targets.length}.` + (failed.length ? " Not sent: " + failed.join("; ") : "");
    toast(failed.length ? `Sent ${sent}, ${failed.length} failed. See the list in the dialog.` : `Sent to ${sent} candidate${sent === 1 ? "" : "s"}. Replies will appear in the WhatsApp tab.`);
  };

  // ---------- Excel bulk WhatsApp (columns Recipient Name, Number, Custom Message; Business API only) ----------
  // A row whose number belongs to a CV is sent in that candidate's conversation; anyone else gets a contact
  // conversation (conversations/xl-<number>) so their replies and STOP still land in the tracker.
  let xlRows = [], xlBusy = false, xlFileName = "";
  async function readSheet(file) {
    if (!window.XLSX) await loadScript(SHEETJS);
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames.find((n) => /recipient/i.test(n)) || wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    const cell = (v) => String(v ?? "").trim();
    const hi = rows.findIndex((r) => r.some((v) => /number|phone|mobile/i.test(cell(v))) && r.some((v) => /message/i.test(cell(v))));
    if (hi < 0) throw new Error("Couldn't find the Number and Custom Message columns. Start from the CapLynk template.");
    const head = rows[hi].map((v) => cell(v).toLowerCase());
    const col = (re) => head.findIndex((v) => re.test(v));
    const [ni, pi, mi] = [col(/name/), col(/number|phone|mobile|whatsapp/), col(/message/)];
    return rows.slice(hi + 1).map((r, i) => ({ line: hi + i + 2, name: cell(r[ni]), number: cell(r[pi]), raw: cell(r[mi]) }))
      .filter((r) => r.name || r.number || r.raw);
  }
  function prepRow(r) {
    const phone = S.toE164Digits(r.number, settings.cc);
    const cand = phone && state.candidates.find((c) => S.toE164Digits(c.phone || c.waPhone, settings.cc) === phone);
    const id = cand ? cand.id : "xl-" + phone, conv = state.conversations[id];
    const name = r.name || (cand ? candLabel(cand) : "");
    const text = r.raw.replace(/\{first\}/g, first(name)).replace(/\{name\}/g, name || "there");
    const tpl = !inWindow(conv);
    const block = !/^\d{8,15}$/.test(phone) ? "number missing or invalid"
      : !text ? "no message"
      : conv?.optedOut || (cand?.waOptOutAt && !cand.waConsent) ? "opted out (replied STOP)"
      : conv?.status === "closed" ? "chat closed"
      : tpl && text.length > 1000 ? "over 1,000 characters" : "";
    return { ...r, phone, cand, id, name, text, tpl, block, ok: null, error: "" };
  }
  async function openSheet(file) {
    if (!file || xlBusy) return;
    let rows;
    try { rows = await readSheet(file); } catch (e) { return toast(e.message || "Couldn't read that file."); }
    if (!rows.length) return toast("That sheet has no recipients under the headings.");
    const seen = new Map();
    xlRows = rows.map(prepRow).map((r) => {
      if (!r.block && seen.has(r.phone)) r.block = "same number as row " + seen.get(r.phone);
      else if (r.phone) seen.set(r.phone, r.line);
      return r;
    });
    xlFileName = file.name;
    $("xlConsent").checked = false; $("xlProgress").textContent = "";
    $("xlNote").hidden = settings.waMode === "api";
    $("xlNote").textContent = LIVE ? "Sending needs the WhatsApp Business API, which isn't available right now. You can still check the sheet here." : "Preview mode: sending works once CapLynk is live with the WhatsApp Business API.";
    renderSheet();
    if (!$("xlDlg").open) $("xlDlg").showModal();
  }
  function renderSheet() {
    const todo = xlRows.filter((r) => !r.block && r.ok !== true).length;
    const sent = xlRows.filter((r) => r.ok === true).length, failed = xlRows.filter((r) => r.ok === false).length, skipped = xlRows.filter((r) => r.block).length;
    $("xlSummary").textContent = `${xlFileName}: ${xlRows.length} row${xlRows.length === 1 ? "" : "s"} · ${todo} to send` + (sent ? ` · ${sent} sent` : "") + (failed ? ` · ${failed} failed` : "") + (skipped ? ` · ${skipped} skipped` : "");
    $("xlRows").innerHTML = xlRows.map((r) => {
      const res = r.block ? `<span class="chip magenta">Skipped</span> ${h(r.block)}`
        : r.ok === true ? `<span class="chip green">Sent</span>`
        : r.ok === false ? `<span class="chip magenta">Failed</span> ${h(r.error)}`
        : r.sending ? `<span class="chip amber">Sending…</span>` : `<span class="chip">Ready</span>`;
      return `<tr><td>${r.line}</td><td>${h(r.name || "No name")}${r.cand ? ' <span class="chip green">Candidate</span>' : ""}</td>
        <td>${/^\d+$/.test(r.phone) ? "+" + h(r.phone) : h(r.number)}</td><td class="msg-cell"><div>${h(r.text)}</div></td>
        <td>${r.block ? "" : r.tpl ? "Template" : "Free text"}</td><td>${res}</td></tr>`;
    }).join("");
    $("xlSendBtn").textContent = todo ? `Send ${todo}` : "Send";
    $("xlSendBtn").disabled = !todo || xlBusy || settings.waMode !== "api" || !$("xlConsent").checked;
    $("xlResultsBtn").hidden = !sent && !failed;
  }
  ["xlFile", "xlFile2"].forEach((id) => ($(id).onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; openSheet(f); }));
  $("xlConsent").onchange = () => renderSheet();
  $("closeXlBtn").onclick = () => { if (!xlBusy) $("xlDlg").close(); };
  $("xlDlg").oncancel = (e) => { if (xlBusy) e.preventDefault(); };
  $("xlSendBtn").onclick = async () => {
    const todo = xlRows.filter((r) => !r.block && r.ok !== true);
    if (!todo.length || !confirm(`Send ${todo.length} WhatsApp message${todo.length === 1 ? "" : "s"} from ${xlFileName}? Each one is logged in the WhatsApp tracker.`)) return;
    xlBusy = true;
    for (const [i, r] of todo.entries()) {
      r.sending = true; renderSheet(); $("xlProgress").textContent = `Sending ${i + 1} of ${todo.length}…`;
      try {
        await api("/api/whatsapp/send", { candidateId: r.id, to: r.phone, text: r.text, useTemplate: r.tpl, ...(r.cand ? {} : { contactName: r.name }) });
        r.ok = true; r.error = "";
      } catch (e) { r.ok = false; r.error = String(e.message || "error").slice(0, 160); }
      r.sending = false;
      await sleep(250); // stays well inside WhatsApp's per-second limit
    }
    xlBusy = false; renderSheet();
    const sent = todo.filter((r) => r.ok).length;
    $("xlProgress").textContent = `Sent ${sent} of ${todo.length}.` + (sent < todo.length ? " Press Send again to retry the failed rows." : "");
    toast(sent < todo.length ? `Sent ${sent}, ${todo.length - sent} failed. Reasons are in the Result column.` : `Sent ${sent}. Delivery and replies appear in the WhatsApp tab.`);
  };
  $("xlResultsBtn").onclick = () => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Row", "Recipient Name", "Number", "Custom Message", "Sent as", "Result"].join(",")].concat(xlRows.map((r) =>
      [r.line, q(r.name), q(r.phone ? "+" + r.phone : r.number), q(r.text), r.block ? "" : r.tpl ? "Template" : "Free text",
        q(r.block ? "Skipped: " + r.block : r.ok === true ? "Sent" : r.ok === false ? "Failed: " + r.error : "Not sent")].join(",")));
    download(xlFileName.replace(/\.[^.]+$/, "") + "-results.csv", "\ufeff" + lines.join("\n") + "\n"); // BOM so Excel reads UTF-8
  };

  // =====================================================================
  // Bulk Message for Roles: everyone in a role's category, their replies and consent, and one bulk WhatsApp send
  // =====================================================================
  // A candidate falls in a role's category when you added them or shortlisted them, you messaged them about the role,
  // their current title names the role (directly or through the taxonomy's alternate titles), or their skills match it at 60%+.
  // Sends reuse /api/whatsapp/send: template outside the 24-hour window, consented candidates only, STOP respected.
  const RB_MATCH = 60;
  const RB_FILTERS = [["all", "All"], ["unread", "Unread"], ["replied", "Replied"], ["noreply", "No reply"], ["failed", "Failed"]];
  const RB_CONSENT = [["any", "Consent: any"], ["optin", "Opted in"], ["unknown", "No consent yet"], ["optout", "Opted out"]];
  const RB_COLORS = ["#16a34a", "#0ea5e9", "#8b5cf6", "#f59e0b", "#ef4444", "#14b8a6", "#ec4899", "#6366f1", "#65a30d", "#f97316"];
  const normTitle = (s) => " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const newestRole = () => [...state.roles].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
  const rbRole = () => state.roles.find((r) => r.id === state.rbRoleId);
  const company = (r) => r.client || "our client";

  function categoryReason(c, r, tax) {
    if ((r.bulkExclude || []).includes(c.id)) return "";
    if ((r.bulkAdd || []).includes(c.id)) return "Added";
    if ((r.shortlist || []).includes(c.id)) return "Shortlisted";
    if ((r.bulkSentTo || []).includes(c.id) || state.conversations[c.id]?.roleId === r.id) return "Messaged";
    const head = normTitle(c.headline), title = normTitle(r.title);
    if (c.headline && title.trim() && head.includes(title)) return "Title match";
    if (tax && c.headline && S.findRole(c.headline)?.id === tax) return "Title match";
    if ((r.skills || []).length && (c.skills || []).length) { const m = S.match(c, r).score; if (m >= RB_MATCH) return "Skills " + m + "%"; }
    return "";
  }
  function roleMembers(r) {
    const tax = r.taxRoleId || S.findRole(r.title)?.id || "";
    return state.candidates.map((c) => ({ c, why: categoryReason(c, r, tax) })).filter((x) => x.why);
  }
  function rbStatus(c) {
    const conv = state.conversations[c.id], msgs = conv?.messages || [];
    const outs = msgs.filter((m) => m.dir === "out"), replied = msgs.some((m) => m.dir === "in");
    const failed = !replied && outs[outs.length - 1]?.status === "failed";
    const consent = conv?.optedOut || (c.waOptOutAt && !c.waConsent) ? "optout" : c.waConsent ? "optin" : "unknown";
    const unread = conv?.unread ? Math.max(1, msgs.length - 1 - msgs.map((m) => m.dir).lastIndexOf("out")) : 0;
    return { conv, replied, failed, noreply: !!outs.length && !replied && !failed, unread, consent, last: [...msgs].reverse().find((m) => m.dir !== "sys") };
  }
  const rbMatches = (st, f) => f === "all" || (f === "unread" ? st.unread > 0 : !!st[f]);
  function rbUnreadTotal() {
    const ids = new Set();
    for (const conv of Object.values(state.conversations)) {
      if (!conv.unread) continue;
      const c = state.candidates.find((x) => x.id === conv.id);
      if (c && state.roles.some((r) => categoryReason(c, r, r.taxRoleId || "") )) ids.add(c.id);
    }
    return ids.size;
  }
  function rbFill(raw, c, r) {
    return fillMessage(raw, c, r).replace(/\{company\}/g, company(r)).replace(/\{location\}/g, r.location || "");
  }
  function rbDefault(r) {
    return "Hi {first}, this is {sender}. We are hiring {a_role} for {company}" + (r.location ? " ({location})" : "") +
      " and your profile looks like a strong match. Would you like to hear more about it?";
  }
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  const avColor = (s) => { let n = 0; for (const ch of String(s)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return RB_COLORS[n % RB_COLORS.length]; };
  const shortTime = (iso) => {
    if (!iso) return ""; const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const consentTag = (k) => k === "optin" ? '<span class="chip green">Opted in</span>' : k === "optout" ? '<span class="chip magenta">Opted out</span>' : '<span class="chip amber">No consent yet</span>';
  function stateTag(st) {
    if (st.failed) return '<span class="chip magenta">Failed</span>';
    if (st.replied) return '<span class="chip green">Replied</span>';
    if (st.noreply) return '<span class="chip">No reply</span>';
    return '<span class="chip">Not messaged</span>';
  }

  $("rbRoleSearch").oninput = (e) => { state.rbRoleQ = e.target.value.toLowerCase(); renderRoleBulk(); };

  function renderRoleBulk() {
    renderUnread();
    const q = state.rbRoleQ;
    const roles = [...state.roles].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .filter((r) => !q || [r.title, r.client, r.location].join(" ").toLowerCase().includes(q));
    $("rbRoleList").innerHTML = roles.length ? roles.map((r) => {
      const mem = roleMembers(r), sts = mem.map((x) => rbStatus(x.c));
      const un = sts.reduce((a, s) => a + s.unread, 0), rep = sts.filter((s) => s.replied).length, sent = (r.bulkSends || []).length;
      return `<li><button data-id="${r.id}" aria-current="${r.id === state.rbRoleId}">
        <span class="li-top"><span>${h(r.title)}</span>${un ? `<span class="chip green">${un} unread</span>` : ""}</span>
        <span class="li-sub">${h([r.client, r.location].filter(Boolean).join(" · ") || "No company yet")}</span>
        <span class="row" style="gap:5px;margin-top:4px"><span class="chip">${mem.length} in category</span>${sent ? `<span class="chip green">${rep} replied</span>` : '<span class="chip">Not sent yet</span>'}</span>
      </button></li>`;
    }).join("") : `<li class="muted" style="padding:14px">${state.roles.length ? "No matches." : "No roles yet. Add one to start."}</li>`;
    $("rbRoleList").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.rbRoleId = b.dataset.id; state.rbPerson = null; state.rbFilter = "all"; state.rbConsent = "any"; state.rbQ = ""; renderRoleBulk(); }));

    const r = rbRole();
    if (!r) {
      $("rbDetail").innerHTML = `<div class="empty"><h3>Bulk Message for Roles</h3><p>Pick a role, or add one, to see every candidate in that role's category. Send them one WhatsApp message together, then follow replies with the All, Unread, Replied, No reply and Failed filters.</p><button class="btn" id="rbEmptyAdd" type="button">+ Add role</button></div>`;
      $("rbEmptyAdd").onclick = () => $("rbNewRoleBtn").click(); return;
    }
    r.bulkDraft ??= rbDefault(r);
    const mem = roleMembers(r).map((x) => ({ ...x, st: rbStatus(x.c) }))
      .sort((a, b) => (b.st.unread - a.st.unread) || (b.st.last?.at || "").localeCompare(a.st.last?.at || "") || candLabel(a.c).localeCompare(candLabel(b.c)));
    const byConsent = mem.filter((x) => state.rbConsent === "any" || x.st.consent === state.rbConsent);
    const pq = state.rbQ;
    const view = byConsent.filter((x) => rbMatches(x.st, state.rbFilter))
      .filter((x) => !pq || [candLabel(x.c), x.c.phone, x.c.waPhone, x.c.headline].join(" ").toLowerCase().includes(pq));
    const count = (f) => byConsent.filter((x) => rbMatches(x.st, f)).length;
    const targets = view.filter((x) => !bulkBlock(x.c));
    const blocked = view.length - targets.length;
    const apiOn = settings.waMode === "api";

    // Sent today across every chat, as a rough guide against Meta's daily limit on new conversations.
    const t = today();
    const sentToday = Object.values(state.conversations).reduce((a, cv) => a + (cv.messages || []).filter((m) => m.dir === "out" && m.via === "api" && (m.at || "").slice(0, 10) === t).length, 0);
    const sends = r.bulkSends || [], lastSend = sends[sends.length - 1];
    const notReplied = mem.filter((x) => x.st.noreply).length;
    const sample = (targets[0] || mem[0])?.c || { name: "Priya Sharma" };

    $("rbDetail").innerHTML = `
      <div class="rb-bar">
        <span class="q ${apiOn ? "" : "off"}"><i></i>${apiOn ? "WhatsApp Business API connected" : LIVE ? "WhatsApp Business API not available" : "Preview mode"}</span>
        <span>Sent today: <b>${sentToday}</b></span>
        <span>Only candidates who agreed to WhatsApp messages are sent to. STOP replies are skipped from then on.</span>
      </div>
      <div class="title-row">
        <div><h1>${h(r.title)}</h1><div class="sub">${h([r.client, r.location].filter(Boolean).join(" · ") || "Add the company under Roles & matching")}</div></div>
        <div class="row"><button class="btn ghost" id="rbAddBtn" type="button">Add candidates</button><button class="btn ghost" id="rbOpenRole" type="button">Role details</button></div>
      </div>
      <div class="rb-sent">${lastSend
        ? `<strong>Message sent</strong> <span class="chip">${sends.length} send${sends.length === 1 ? "" : "s"}</span> <span>Latest ${h(fmtTime(lastSend.at))} to ${lastSend.sent} ${lastSend.sent === 1 ? "person" : "people"}${lastSend.failed ? ` (${lastSend.failed} failed)` : ""}. ${notReplied} ${notReplied === 1 ? "has" : "have"} not replied.</span>`
        : `<strong>Not sent yet</strong> <span>${mem.length} candidate${mem.length === 1 ? "" : "s"} in this role's category, ${mem.filter((x) => !bulkBlock(x.c)).length} can receive WhatsApp messages.</span>`}</div>

      <div class="card"><h3>Bulk message <span class="muted" style="font:500 13px Figtree, sans-serif">goes to the candidates in the list below, as filtered</span></h3>
        <div class="rb-compose">
          <div>
            <textarea id="rbText" maxlength="1000" aria-label="Bulk message">${h(r.bulkDraft)}</textarea>
            <div class="rb-vars">Insert: ${["first", "role", "a_role", "company", "location", "sender"].map((v) => `<button type="button" data-var="${v}">{${v}}</button>`).join("")}<span style="margin-left:auto" id="rbLen">${r.bulkDraft.length} / 1000</span></div>
            <p class="muted" style="margin:8px 0 0;font-size:13px">{first} becomes each candidate's first name, {a_role} reads "${h(/^[aeiou]/i.test(r.title) ? "an " : "a ")}${h(r.title)}". People who replied in the last 24 hours get it as written; everyone else gets it inside your approved caplynk_outreach template as one paragraph.</p>
          </div>
          <div class="rb-preview" aria-label="Preview"><span class="muted" style="font-size:12px;font-weight:600">PREVIEW FOR ${h(first(candLabel(sample)).toUpperCase())}</span><div class="msg out" id="rbPreview">${h(rbFill(r.bulkDraft, sample, r))}</div></div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn wa" id="rbSendBtn" type="button" ${!targets.length || state.rbBusy || !apiOn ? "disabled" : ""}>${state.rbBusy ? "Sending…" : targets.length ? `Send to ${targets.length}` : "Send"}</button>
          <span class="muted" style="font-size:13.5px" role="status">${h(state.rbProgress || (
            !apiOn ? (LIVE ? "Bulk sending needs the WhatsApp Business API." : "Preview mode: sending works once CapLynk is live.")
            : `${targets.length} of ${view.length} in this view can receive it` + (blocked ? `; ${blocked} skipped (${rbSkipSummary(view)})` : "") + "."))}</span>
        </div>
      </div>

      <div class="rb-conv">
        <div class="rb-list">
          <div class="ph">
            <input class="search" id="rbSearch" type="search" placeholder="Search name or phone" value="${h(state.rbQ)}">
            <div class="rb-filters" role="group" aria-label="Filter candidates">
              ${RB_FILTERS.map(([k, l]) => `<button type="button" data-rbf="${k}" aria-pressed="${state.rbFilter === k}">${l}<span class="n">${count(k)}</span></button>`).join("")}
              <select id="rbConsent" aria-label="Consent">${RB_CONSENT.map(([k, l]) => `<option value="${k}" ${state.rbConsent === k ? "selected" : ""}>${l}</option>`).join("")}</select>
            </div>
          </div>
          <ul class="rb-people">${view.length ? view.map(({ c, st, why }) => `
            <li><button data-p="${c.id}" aria-current="${c.id === state.rbPerson}" class="${st.unread ? "un" : ""}">
              <span class="rb-av" style="background:${avColor(c.id)}">${h(initials(candLabel(c)))}</span>
              <span class="pn">${st.unread ? '<span class="dot" style="background:#25D366"></span>' : ""}<span>${h(candLabel(c))}</span><span class="time">${h(shortTime(st.last?.at))}</span></span>
              <span class="snip">${h(st.last ? (st.last.dir === "out" ? "You: " : "") + st.last.text : [c.headline, why].filter(Boolean).join(" · "))}</span>
              <span class="tags">${consentTag(st.consent)}${stateTag(st)}${st.unread ? `<span class="badge">${st.unread}</span>` : ""}</span>
            </button></li>`).join("") : `<li class="muted" style="padding:14px">${mem.length ? "No one matches these filters." : "No candidates in this role's category yet. Parse CVs, shortlist people under Roles & matching, or use Add candidates."}</li>`}</ul>
        </div>
        <div class="rb-chat" id="rbChat"></div>
      </div>`;

    $("rbText").oninput = (e) => { r.bulkDraft = e.target.value; $("rbPreview").textContent = rbFill(r.bulkDraft, sample, r); $("rbLen").textContent = r.bulkDraft.length + " / 1000"; };
    $("rbText").onchange = () => save("roles", r);
    $("rbDetail").querySelectorAll("[data-var]").forEach((b) => (b.onclick = () => {
      const ta = $("rbText"), ins = "{" + b.dataset.var + "}", at = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at); ta.focus(); ta.selectionStart = ta.selectionEnd = at + ins.length;
      ta.oninput({ target: ta }); save("roles", r);
    }));
    $("rbSearch").oninput = (e) => { state.rbQ = e.target.value.toLowerCase(); renderRoleBulk(); const s = $("rbSearch"); s.focus(); s.selectionStart = s.selectionEnd = s.value.length; };
    $("rbDetail").querySelectorAll("[data-rbf]").forEach((b) => (b.onclick = () => { state.rbFilter = b.dataset.rbf; renderRoleBulk(); }));
    $("rbConsent").onchange = (e) => { state.rbConsent = e.target.value; renderRoleBulk(); };
    $("rbDetail").querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { state.rbPerson = b.dataset.p; state.rbReply = ""; renderRoleBulk(); }));
    $("rbAddBtn").onclick = () => openRbAdd(r);
    $("rbOpenRole").onclick = () => { state.roleId = r.id; setTab("roles"); };
    $("rbSendBtn").onclick = () => rbSend(r, targets.map((x) => x.c));
    renderRbChat(r, mem.find((x) => x.c.id === state.rbPerson));
  }

  function rbSkipSummary(view) {
    const n = {};
    view.forEach((x) => { const why = bulkBlock(x.c); if (why) n[why] = (n[why] || 0) + 1; });
    return Object.entries(n).map(([k, v]) => v + " " + k).join(", ");
  }

  function renderRbChat(r, m) {
    const box = $("rbChat");
    if (!m) { box.innerHTML = `<div class="empty" style="margin:auto;padding:16px"><h3 style="font-size:18px">Pick a candidate</h3><p>Their WhatsApp chat opens here. Reply within 24 hours of their last message as free text; after that CapLynk uses your approved template.</p></div>`; return; }
    const { c, st, why } = m, conv = st.conv;
    if (conv?.unread) { conv.unread = false; save("conversations", conv); renderUnread(); }
    const phone = S.toE164Digits(c.phone || c.waPhone, settings.cc);
    const block = bulkBlock(c), closed = conv?.status === "closed";
    const optout = st.consent === "optout";
    const note = optout ? ["bad", "Opted out. CapLynk won't message " + first(candLabel(c)) + " unless they opt back in and you record their consent again."]
      : closed ? ["bad", "This chat is closed. Reopen it in the WhatsApp tab to message them."]
      : !phone ? ["bad", "No phone number on this CV yet."]
      : inWindow(conv) ? ["ok", "They replied in the last 24 hours, so your reply goes as free text."]
      : ["tpl", "Outside the 24-hour window: your message goes inside the approved template."];
    box.innerHTML = `
      <div class="chat-head">
        <div class="title-row" style="margin:0">
          <div><h1 style="font-size:19px">${h(candLabel(c))}</h1>
            <div class="sub" style="font-size:13px">${h([phone ? "+" + phone : "", c.headline].filter(Boolean).join(" · "))} · <span title="Why they're in this role's category">${h(why)}</span></div></div>
          <div class="row">
            <button class="btn ghost sm" id="rbConsentBtn" type="button">${c.waConsent ? "Remove consent" : "Record consent"}</button>
            <button class="btn ghost sm" id="rbViewCv" type="button">View CV</button>
            <button class="btn ghost sm" id="rbInWa" type="button">Open in WhatsApp tab</button>
            <button class="btn danger sm" id="rbRemove" type="button">Remove from role</button>
          </div>
        </div>
        <div class="row" style="font-size:13px">WhatsApp consent: ${consentTag(st.consent)}<span class="muted">${h(c.waConsent ? (c.waConsentBy === "admin" ? "Recorded by the admin " : "Ticked on Applicant Data ") + fmtTime(c.waConsentAt) : optout ? "Replied STOP " + fmtTime(conv?.optedOutAt || c.waOptOutAt) : "Bulk messages skip them until they agree")}</span></div>
      </div>
      <div class="rb-note ${note[0]}">${h(note[1])}</div>
      <div class="msgs" id="rbMsgs">
        ${conv?.messages?.length ? conv.messages.map((x) => x.dir === "sys" ? `<div class="sys">${h(x.text)} · ${fmtTime(x.at)}</div>` : `
          <div class="msg ${x.dir}">${h(x.text)}<div class="meta">${fmtTime(x.at)}${x.dir === "out" ? " · " + h(x.status || "sent") + (x.error ? ": " + h(x.error) : "") : ""}</div></div>`).join("")
          : '<div class="sys">No messages yet</div>'}
      </div>
      <div class="composer">
        <textarea id="rbReply" placeholder="${block && block !== "no WhatsApp consent" ? "Messaging not available" : "Message to " + h(first(candLabel(c)))}" ${optout || closed || !phone ? "disabled" : ""}>${h(state.rbReply)}</textarea>
        <div class="row" style="justify-content:flex-end"><button class="btn wa" id="rbReplyBtn" type="button" ${optout || closed || !phone ? "disabled" : ""}>Send</button></div>
      </div>`;
    const msgs = $("rbMsgs"); msgs.scrollTop = msgs.scrollHeight;
    $("rbConsentBtn").onclick = () => toggleConsent(c, renderRoleBulk);
    $("rbViewCv").onclick = () => { state.candId = c.id; setTab("cvs"); };
    $("rbInWa").onclick = () => openChat(c.id);
    $("rbRemove").onclick = () => {
      if (!confirm("Remove " + candLabel(c) + " from " + r.title + "? Their chat history stays in the WhatsApp tab.")) return;
      r.bulkAdd = (r.bulkAdd || []).filter((id) => id !== c.id);
      r.bulkExclude = [...new Set([...(r.bulkExclude || []), c.id])];
      state.rbPerson = null; save("roles", r); renderRoleBulk();
    };
    $("rbReply").oninput = (e) => (state.rbReply = e.target.value);
    $("rbReplyBtn").onclick = async () => {
      const cv = ensureConv(c.id); if (!cv.roleId) cv.roleId = r.id;
      await sendWhatsApp(cv, c, phone, state.rbReply.trim(), $("rbReplyBtn"), () => { state.rbReply = ""; renderRoleBulk(); });
    };
  }

  async function rbSend(r, targets) {
    const raw = ($("rbText").value || "").trim();
    if (!raw) return toast("Write the message first.");
    if (!targets.length) return;
    r.bulkDraft = raw;
    const over = targets.filter((c) => !inWindow(state.conversations[c.id]) && rbFill(raw, c, r).length > 1000);
    if (over.length) return toast("The message is over 1,000 characters for " + over.length + " candidate" + (over.length === 1 ? "" : "s") + ". Shorten it first.");
    if (!confirm(`Send this WhatsApp message about ${r.title} to ${targets.length} candidate${targets.length === 1 ? "" : "s"}? Each one is logged in their chat.`)) return;
    state.rbBusy = true;
    let sent = 0; const failed = [];
    for (const [i, c] of targets.entries()) {
      state.rbProgress = `Sending ${i + 1} of ${targets.length}…`; renderRoleBulk();
      try {
        await api("/api/whatsapp/send", { candidateId: c.id, to: S.toE164Digits(c.phone || c.waPhone, settings.cc), text: rbFill(raw, c, r), useTemplate: !inWindow(state.conversations[c.id]), roleId: r.id });
        sent++; r.bulkSentTo = [...new Set([...(r.bulkSentTo || []), c.id])];
        const conv = ensureConv(c.id); if (!conv.roleId) conv.roleId = r.id;
      } catch (e) { failed.push(candLabel(c) + ": " + String(e.message || "error").slice(0, 120)); }
      await sleep(250); // stays well inside WhatsApp's per-second limit
    }
    r.bulkSends = [...(r.bulkSends || []), { at: now(), text: raw, count: targets.length, sent, failed: failed.length, filter: state.rbFilter, consent: state.rbConsent }];
    await save("roles", r);
    state.rbBusy = false;
    state.rbProgress = `Sent ${sent} of ${targets.length}.` + (failed.length ? " Not sent: " + failed.join("; ") : " Replies appear here and in the WhatsApp tab.");
    renderRoleBulk();
    toast(failed.length ? `Sent ${sent}, ${failed.length} failed.` : `Sent to ${sent} candidate${sent === 1 ? "" : "s"}.`);
    setTimeout(() => { state.rbProgress = ""; }, 15000);
  }

  // ---------- add role / add candidates ----------
  $("rbNewRoleBtn").onclick = () => { $("rbRoleForm").reset(); $("rbRoleDlg").showModal(); $("rbTitle").focus(); };
  $("rbRoleDlg").onclose = async () => {
    if ($("rbRoleDlg").returnValue !== "ok") return;
    const title = $("rbTitle").value.trim(); if (!title) return;
    const r = { id: uid(), title, client: $("rbClient").value.trim(), location: $("rbLocation").value.trim(), description: "", skills: [], shortlist: [], summaries: {}, createdAt: now() };
    const tax = S.findRole(title); if (tax) { r.taxRoleId = tax.id; }
    await save("roles", r); state.rbRoleId = r.id; state.rbPerson = null; renderRoleBulk();
    toast(title + " added. Candidates whose title names it appear on their own; use Add candidates for anyone else.");
  };

  let rbAddRole = null, rbAddPick = new Set();
  function openRbAdd(r) {
    rbAddRole = r; rbAddPick = new Set(); $("rbAddSearch").value = "";
    $("rbAddTitle").textContent = "Add candidates to " + r.title;
    drawRbAdd(); $("rbAddDlg").showModal();
  }
  function drawRbAdd() {
    const r = rbAddRole, inRole = new Set(roleMembers(r).map((x) => x.c.id)), q = $("rbAddSearch").value.toLowerCase();
    const list = state.candidates.filter((c) => !inRole.has(c.id))
      .filter((c) => !q || [candLabel(c), c.headline, c.email, ...(c.skills || []).map((s) => S.BY_CODE[s.code]?.name || s.code)].join(" ").toLowerCase().includes(q));
    $("rbAddList").innerHTML = list.length ? list.map((c) => {
      const why = bulkBlock(c), m = (r.skills || []).length && (c.skills || []).length ? S.match(c, r).score : null;
      return `<li><label><input type="checkbox" data-add="${c.id}" ${rbAddPick.has(c.id) ? "checked" : ""}>
        <span><strong>${h(candLabel(c))}</strong> <span class="muted">${h([c.headline, m != null ? m + "% skills match" : ""].filter(Boolean).join(" · "))}</span></span>
        ${why ? `<span class="chip ${why === "opted out" ? "magenta" : "amber"}">${why}</span>` : ""}</label></li>`;
    }).join("") : `<li class="muted" style="padding:12px">${state.candidates.length ? "Everyone is already in this role's category." : "No CVs yet."}</li>`;
    $("rbAddList").querySelectorAll("[data-add]").forEach((el) => (el.onchange = () => { el.checked ? rbAddPick.add(el.dataset.add) : rbAddPick.delete(el.dataset.add); rbAddCount(); }));
    rbAddCount();
  }
  function rbAddCount() { $("rbAddGo").disabled = !rbAddPick.size; $("rbAddGo").textContent = rbAddPick.size ? `Add ${rbAddPick.size}` : "Add"; }
  $("rbAddSearch").oninput = drawRbAdd;
  $("rbAddClose").onclick = () => $("rbAddDlg").close();
  $("rbAddGo").onclick = async () => {
    const r = rbAddRole, ids = [...rbAddPick];
    r.bulkAdd = [...new Set([...(r.bulkAdd || []), ...ids])];
    r.bulkExclude = (r.bulkExclude || []).filter((id) => !rbAddPick.has(id));
    await save("roles", r); $("rbAddDlg").close(); renderRoleBulk();
    toast("Added " + ids.length + " to " + r.title + ".");
  };

  // =====================================================================
  // M4: role skill profiles, matching, and the client summary card
  // =====================================================================
  $("newRoleBtn").onclick = async () => {
    const r = { id: uid(), title: "New role", client: "", location: "", description: "", skills: [], shortlist: [], summaries: {}, createdAt: now() };
    await save("roles", r); state.roleId = r.id; renderRoles(); setTimeout(() => $("roleDetail").querySelector("[data-r=title]")?.select(), 0);
  };

  function renderRoles() {
    $("roleList").innerHTML = state.roles.length ? state.roles.map((r) => `
      <li><button data-id="${r.id}" aria-current="${r.id === state.roleId}">
        <span class="li-top"><span>${h(r.title)}</span>${r.shortlist?.length ? `<span class="chip green">${r.shortlist.length} shortlisted</span>` : ""}</span>
        <span class="li-sub">${h([r.client, r.location].filter(Boolean).join(" · ") || (r.skills.length + " skills"))}</span>
      </button></li>`).join("") : `<li class="muted" style="padding:14px">No roles yet.</li>`;
    $("roleList").querySelectorAll("button").forEach((b) => (b.onclick = () => { state.roleId = b.dataset.id; renderRoles(); }));

    const r = state.roles.find((x) => x.id === state.roleId);
    if (!r) { $("roleDetail").innerHTML = `<div class="empty"><h3>Match candidates to a role</h3><p>Create a role, pick its taxonomy role or paste the job description, and CapLynk builds its skill profile, ranks your parsed candidates, and lays out a summary card for the client.</p><button class="btn" id="emptyRole" type="button">New role</button></div>`; $("emptyRole").onclick = () => $("newRoleBtn").click(); return; }
    r.shortlist ||= []; r.summaries ||= {};
    const parsed = state.candidates.filter((c) => c.status === "parsed" || (c.skills || []).length);
    const ranked = parsed.map((c) => ({ c, m: S.match(c, r) })).sort((a, b) => b.m.score - a.m.score);
    $("roleDetail").innerHTML = `
      <div class="title-row"><div><h1>${h(r.title)}</h1><div class="sub">${h([r.client, r.location].filter(Boolean).join(" · "))}</div></div>
        <div class="row"><button class="btn wa" id="bulkRoleBtn" type="button" ${r.shortlist.length ? "" : "disabled title='Shortlist candidates first'"}>WhatsApp shortlist</button><button class="btn" id="presentBtn" type="button" ${r.shortlist.length ? "" : "disabled"}>Present ${r.shortlist.length || ""} to client</button><button class="btn danger" id="delRoleBtn" type="button">Delete role</button></div></div>
      <div class="card"><h3>Role</h3>
        <div class="grid">
          <label class="f">Job title<input data-r="title" value="${h(r.title)}"></label>
          <label class="f">Client<input data-r="client" value="${h(r.client)}"></label>
          <label class="f">Location<input data-r="location" value="${h(r.location)}"></label>
        </div>
        <label class="f" style="margin-top:12px">Job description<textarea data-r="description" rows="6" placeholder="Paste the client's job description">${h(r.description)}</textarea></label>
        <div class="grid" style="margin-top:12px">
          <label class="f">Taxonomy role<select data-r="taxRoleId"><option value="">Find from the job title</option>${roleOptions(r.taxRoleId)}</select></label>
          <label class="f">Seniority band<select data-r="band"><option value="">From the description</option>${S.BANDS.map((b) => `<option ${r.band === b ? "selected" : ""}>${b}</option>`).join("")}</select></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="btn ghost sm" for="jdFile">Upload JD file</label>
          <input id="jdFile" type="file" accept=".pdf,.docx,.txt,.md" hidden>
          <button class="btn ghost sm" id="extractBtn" type="button">Build skill profile from description</button>
        </div>
      </div>
      ${oldSkills(r.skills) ? '<div class="warn">This role still uses old SFIA skills. Click "Build skill profile" to rebuild it on the CapLynk Capability Taxonomy.</div>' : ""}
      <div class="card"><h3>Job skill profile${r.taxRoleName ? ` <span class="muted" style="font:500 13px Figtree">from ${h(r.taxRoleName)}${r.band ? ", " + h(r.band) : ""}</span>` : ""} <button class="btn ghost sm" id="addReqBtn" type="button">Add skill</button></h3>${skillTable(r.skills, "role")}</div>
      <div class="card"><h3>Matching candidates <span class="muted" style="font:500 13px Figtree">${parsed.length} parsed candidates ranked</span></h3>
        ${!r.skills.length ? '<p class="muted" style="margin:0">Add required skills to rank candidates.</p>' : !ranked.length ? '<p class="muted" style="margin:0">Parse some CVs first.</p>' : ranked.map(({ c, m }) => `
          <div class="match">
            <div class="score" style="--p:${m.score}"><span>${m.score}</span></div>
            <div><strong>${h(candLabel(c))}</strong> <span class="muted">${h([c.headline, c.location].filter(Boolean).join(" · "))}</span>
              <div class="muted" style="font-size:13px">Meets ${m.met} of ${m.rows.length} skills at the required level${m.missingMust.length ? ` · <span style="color:var(--magenta)">missing must-have: ${m.missingMust.map((x) => x.code).join(", ")}</span>` : ""}</div>
              <div class="bars">${m.rows.map((x) => `<span class="code ${x.met ? "ok" : "gap"}" title="${h(x.name)}: needs ${x.need}, has ${x.level || "none"}">${x.code} ${x.level || "–"}/${x.need}</span>`).join("")}</div></div>
            <div class="row"><button class="btn wa sm" data-wa="${c.id}" type="button" ${c.phone ? "" : "disabled"}>WhatsApp</button>
              <label class="row" style="font-size:13px;font-weight:600"><input type="checkbox" data-sl="${c.id}" ${r.shortlist.includes(c.id) ? "checked" : ""}> Shortlist</label></div>
          </div>`).join("")}
      </div>`;
    $("roleDetail").querySelectorAll("[data-r]").forEach((el) => (el.onchange = () => { r[el.dataset.r] = el.value.trim(); save("roles", r); renderRoles(); }));
    wireSkillTable(r.skills, () => save("roles", r), "role");
    $("addReqBtn").onclick = () => { r.skills.push({ code: unusedCode(r.skills), minLevel: 3, mustHave: false }); save("roles", r); renderRoles(); };
    $("jdFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      try {
        const text = (await extractText(f)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (!text) return toast(f.name + " has no readable text (scanned image?)");
        r.description = text.slice(0, 30000); r.jdFileName = f.name;
        await save("roles", r); renderRoles();
        toast("Job description loaded from " + f.name + ". Edit it if needed, then build the skill profile.");
      } catch (err) { toast(err.message || "Couldn't read " + f.name); }
    };
    $("extractBtn").onclick = async () => {
      const desc = $("roleDetail").querySelector("[data-r=description]").value.trim(); r.description = desc;
      if (!desc && !r.taxRoleId) return toast("Pick a taxonomy role or paste the job description first.");
      if (!S.META.loaded) return toast("Import the CapLynk Capability Taxonomy in Settings first.");
      // Gaplyn's role map comes first (picked role, or one named in the title); the JD adds skills it mentions beyond that.
      const local = S.parseJobText(desc, r.title);
      const role = S.ROLES.find((x) => x.id === r.taxRoleId) || (local.role && S.ROLES.find((x) => x.id === local.role.id));
      const band = r.band || local.band;
      const base = role ? S.roleProfile(role, S.BANDS.indexOf(band)) : [];
      let found;
      try { found = desc ? (await api("/api/profiles", { action: "job", text: desc })).profile.skills : []; }
      catch { found = local.filter((x) => !base.some((b) => b.code === x.code)); }
      const have = new Set(base.map((x) => x.code));
      const extra = (found || []).filter((x) => S.BY_CODE[x.code] && !have.has(x.code)).slice(0, role ? 4 : 12);
      r.skills = [...base, ...extra].map((x) => ({ code: x.code, minLevel: clampLevel(x.minLevel), mustHave: !!x.mustHave }));
      r.taxRoleName = role ? role.name : ""; r.band = role ? band : r.band;
      if (role && !r.taxRoleId) r.taxRoleId = role.id;
      await save("roles", r); renderRoles();
      toast(r.skills.length ? (role ? "Built from " + role.name + " (" + band + ")" : "Skill profile built") + ". Adjust levels and must-haves as needed." : "No taxonomy skills recognised. Pick a taxonomy role or add skills by hand.");
    };
    $("roleDetail").querySelectorAll("[data-sl]").forEach((el) => (el.onchange = () => {
      const id = el.dataset.sl; r.shortlist = el.checked ? [...new Set([...r.shortlist, id])] : r.shortlist.filter((x) => x !== id);
      save("roles", r); renderRoles();
    }));
    $("roleDetail").querySelectorAll("[data-wa]").forEach((b) => (b.onclick = () => { const conv = ensureConv(b.dataset.wa); if (!conv.roleId) conv.roleId = r.id; openChat(b.dataset.wa); }));
    $("presentBtn").onclick = () => openClientCard(r);
    $("bulkRoleBtn").onclick = () => openBulk({ ids: r.shortlist, roleId: r.id });
    $("delRoleBtn").onclick = async () => { if (!confirm("Delete the role " + r.title + "?")) return; await remove("roles", r.id); state.roleId = state.roles[0]?.id || null; renderRoles(); };
  }

  function roleOptions(sel) {
    let fam = "", out = "";
    for (const x of [...S.ROLES].sort((a, b) => (a.family + a.name).localeCompare(b.family + b.name))) {
      if (x.family !== fam) { out += (fam ? "</optgroup>" : "") + `<optgroup label="${h(x.family)}">`; fam = x.family; }
      out += `<option value="${h(x.id)}" ${x.id === sel ? "selected" : ""}>${h(x.name)}</option>`;
    }
    return out + (fam ? "</optgroup>" : "");
  }

  function templateSummary(c, r, m) {
    const strong = m.rows.filter((x) => x.met).sort((a, b) => b.level - a.level).slice(0, 3).map((x) => x.name.toLowerCase());
    const gaps = m.rows.filter((x) => !x.met).map((x) => x.name.toLowerCase());
    const yrs = c.yearsExperience ? ` with ${c.yearsExperience} years' experience` : "";
    return `${first(c.name)} is ${/^[aeiou]/i.test(c.headline || "") ? "an" : "a"} ${c.headline || "candidate"}${yrs}${c.location ? ", based in " + c.location : ""}. ` +
      `Against the ${r.title} profile they meet ${m.met} of ${m.rows.length} required skills at or above the level asked for` +
      (strong.length ? `, with particular strength in ${strong.join(", ").replace(/, ([^,]*)$/, " and $1")}.` : ".") +
      (gaps.length ? ` Areas to probe at interview: ${gaps.join(", ")}.` : "");
  }

  let cardRole = null;
  async function openClientCard(r) {
    cardRole = r;
    const items = r.shortlist.map((id) => state.candidates.find((c) => c.id === id)).filter(Boolean);
    for (const c of items) {
      if (r.summaries[c.id]) continue;
      const m = S.match(c, r);
      try { r.summaries[c.id] = (await api("/api/profiles", { action: "summary", candidate: slim(c), role: { title: r.title, client: r.client, skills: r.skills }, match: m })).summary; }
      catch { r.summaries[c.id] = c.summary ? c.summary : templateSummary(c, r, m); }
    }
    await save("roles", r);
    drawCards(); $("cardDlg").showModal();
  }
  const slim = (c) => ({ name: c.name, headline: c.headline, location: c.location, yearsExperience: c.yearsExperience, skills: c.skills, summary: c.summary, cvText: (c.cvText || "").slice(0, 12000) });

  function drawCards() {
    const r = cardRole, hide = $("hideContact").checked;
    const items = r.shortlist.map((id) => state.candidates.find((c) => c.id === id)).filter(Boolean);
    const date = new Date().toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
    $("cardBody").innerHTML = items.map((c) => {
      const m = S.match(c, r);
      const extras = Object.fromEntries((c.skills || []).map((s) => [s.code, s]));
      r.skills.forEach((s) => delete extras[s.code]);
      const other = Object.values(extras).slice(0, 6).map((s) => `${S.BY_CODE[s.code]?.name || s.code} (L${s.level})`).join(", ");
      return `<article class="ccard" data-id="${c.id}">
        <div class="cc-top"><div class="cc-brand"><span class="tile" style="width:24px;height:24px;font-size:14px;border-radius:6px">G</span>CapLynk <span style="font:500 12px Figtree;color:#566070">by Gaplyn Services</span></div>
          <div class="cc-for">${h(r.title)}${r.client ? " · for " + h(r.client) : ""}<br>${date}</div></div>
        <div class="cc-head"><div><h2>${h(c.name || "Candidate")}</h2>
          <div class="cc-meta">${h([c.headline, c.location, c.yearsExperience ? c.yearsExperience + " years' experience" : "", c.notice ? "Notice: " + c.notice : ""].filter(Boolean).join(" · "))}</div>
          ${hide ? "" : `<div class="cc-meta">${h([c.email, c.phone, c.linkedin].filter(Boolean).join(" · "))}</div>`}</div>
          <div class="cc-score">${m.score}%<small>skills match</small></div></div>
        <p class="cc-summary" contenteditable="true" spellcheck="true">${h(r.summaries[c.id] || "")}</p>
        <table><thead><tr><th>Skill</th><th>Required</th><th>Candidate</th><th></th></tr></thead><tbody>
          ${m.rows.map((x) => `<tr><td>${h(x.name)} <span style="color:#566070;font-size:12px">${x.code}${x.mustHave ? " · essential" : ""}</span></td><td>Level ${x.need}</td><td>${x.level ? "Level " + x.level : "Not evidenced"}</td><td class="${x.met ? "yes" : "no"}">${x.met ? "✓ Meets" : "Gap"}</td></tr>`).join("")}
        </tbody></table>
        ${other ? `<div class="cc-foot"><strong>Also brings:</strong> ${h(other)}</div>` : ""}
        <div class="cc-foot">Skills and levels follow the CapLynk Capability Taxonomy (${h(S.LEVELS[1] || "L1")} to ${h(S.LEVELS[S.LEVELS.length - 1] || "L6")}). Presented by ${h(settings.sender || "Gaplyn Services")}.</div>
      </article>`;
    }).join("") || '<p class="muted">Shortlist candidates on the role first.</p>';
    $("cardBody").querySelectorAll(".cc-summary").forEach((p) => (p.onblur = () => { r.summaries[p.closest(".ccard").dataset.id] = p.innerText.trim(); save("roles", r); }));
    const mail = cardText();
    $("emailCardBtn").href = "mailto:?subject=" + encodeURIComponent("Candidates for " + r.title) + "&body=" + encodeURIComponent(mail.slice(0, 1800));
  }
  function cardText() {
    const r = cardRole, hide = $("hideContact").checked;
    return `Candidates for ${r.title}${r.client ? " (" + r.client + ")" : ""}\n\n` + r.shortlist.map((id) => state.candidates.find((c) => c.id === id)).filter(Boolean).map((c) => {
      const m = S.match(c, r);
      return `${c.name} · ${m.score}% skills match\n${[c.headline, c.location, c.yearsExperience ? c.yearsExperience + " years" : ""].filter(Boolean).join(" · ")}` +
        (hide ? "" : `\n${[c.email, c.phone].filter(Boolean).join(" · ")}`) + `\n${r.summaries[c.id] || ""}\n` +
        m.rows.map((x) => `- ${x.name}: needs L${x.need}, has ${x.level ? "L" + x.level : "none"}${x.met ? " ✓" : ""}`).join("\n");
    }).join("\n\n");
  }
  $("hideContact").onchange = drawCards;
  $("closeCardBtn").onclick = () => { $("cardDlg").close(); renderRoles(); };
  $("printCardBtn").onclick = () => window.print();
  $("copyCardBtn").onclick = async () => { try { await navigator.clipboard.writeText(cardText()); toast("Copied. Paste it into an email to the client."); } catch { toast("Copy blocked by the browser."); } };

  // ---------- CapLynk Capability Taxonomy ----------
  // Imported from Gaplyn's Excel workbook and kept in Firestore (taxonomy/meta, taxonomy/skills, taxonomy/roles),
  // readable only by the Super Admin. Re-import the workbook to update it; skill and role IDs are the join keys.
  const TAX_KEY = "caplynk.taxonomy";
  const SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  function useTaxonomy(tax) {
    S.load(tax); optionCache = "";
    renderTaxonomy(); render();
  }
  async function loadTaxonomy() {
    if (!LIVE) { const t = lsGet(TAX_KEY, null); if (t) useTaxonomy(t); else renderTaxonomy(); return; }
    try {
      const get = (id) => fb.fs.getDoc(fb.fs.doc(fb.db, "taxonomy", id));
      const [m, sk, ro] = await Promise.all([get("meta"), get("skills"), get("roles")]);
      if (m.exists() && sk.exists()) useTaxonomy({ ...m.data(), skills: sk.data().items || [], roles: ro.exists() ? ro.data().items || [] : [] });
      else renderTaxonomy();
    } catch (e) { console.error(e); toast("Couldn't load the capability taxonomy. Check the Firestore rules are deployed."); renderTaxonomy(); }
  }
  function renderTaxonomy() {
    const m = S.META;
    $("taxBanner").hidden = m.loaded;
    $("taxStatus").textContent = m.loaded
      ? `${m.title}${m.version ? " v" + m.version : ""}: ${S.SKILLS.length} skills, ${S.ROLES.length} roles, levels ${S.LEVELS[1]} to ${S.LEVELS[S.LEVELS.length - 1]}.`
      : "No taxonomy imported yet. Import the CapLynk Capability Taxonomy workbook (.xlsx).";
  }
  async function importTaxonomy(file) {
    try {
      if (!window.XLSX) await loadScript(SHEETJS);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheets = Object.fromEntries(wb.SheetNames.map((n) => [n, window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true })]));
      const tax = JSON.parse(JSON.stringify(S.fromSheets(sheets)));
      if (!confirm(`Import ${tax.title}${tax.version ? " v" + tax.version : ""}: ${tax.skills.length} skills and ${tax.roles.length} roles? This replaces the framework CapLynk uses for every profile.`)) return;
      if (LIVE) {
        const { setDoc, doc } = fb.fs, at = now();
        await setDoc(doc(fb.db, "taxonomy", "skills"), { items: tax.skills, importedAt: at });
        await setDoc(doc(fb.db, "taxonomy", "roles"), { items: tax.roles, importedAt: at });
        await setDoc(doc(fb.db, "taxonomy", "meta"), { title: tax.title, version: tax.version, levels: tax.levels, fileName: file.name, importedAt: at, importedBy: fb.user.email, skillCount: tax.skills.length, roleCount: tax.roles.length });
      } else lsSet(TAX_KEY, tax);
      useTaxonomy(tax);
      toast("Imported " + tax.skills.length + " skills and " + tax.roles.length + " roles. Parse CVs and rebuild roles to use it.");
    } catch (e) { console.error(e); toast(e.message || "Couldn't read that workbook."); }
  }
  $("taxFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importTaxonomy(f); };
  $("taxBannerBtn").onclick = () => $("settingsBtn").click();

  // ---------- settings ----------
  $("settingsBtn").onclick = () => {
    $("setCc").value = settings.cc; $("setSender").value = settings.sender;
    $("waModeNote").textContent = settings.waMode === "api" ? "WhatsApp Business API is connected: messages send from CapLynk, replies arrive in the tracker, and bulk sending is on." : "Send opens WhatsApp with the message ready. Paste the candidate's replies in with \"Log their reply\" so the log stays complete. Bulk sending turns on once the WhatsApp Business API is set up.";
    $("storageNote").textContent = LIVE ? "CVs, roles and WhatsApp logs are saved in Firestore, readable only by the Super Admin account." : "Preview mode: data is saved only in this browser.";
    $("settingsDlg").showModal();
  };
  $("setCc").onchange = (e) => { settings.cc = e.target.value.replace(/\D/g, ""); lsSet(SET_KEY, settings); };
  $("setSender").onchange = (e) => { settings.sender = e.target.value.trim(); lsSet(SET_KEY, settings); };
  $("closeSettingsBtn").onclick = () => { $("settingsDlg").close(); render(); };
  $("exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify({ candidates: state.candidates, roles: state.roles, conversations: state.conversations }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "caplynk-export.json"; a.click();
  };

  // ---------- boot ----------
  async function boot() {
    if (!LIVE) {
      const d = lsGet(LS_KEY, {});
      Object.assign(state, { candidates: d.candidates || [], roles: d.roles || [], conversations: d.conversations || {} });
      state.candId = state.candidates[0]?.id || null; state.roleId = state.roles[0]?.id || null; state.rbRoleId = newestRole()?.id || null;
      $("gate").hidden = true; document.body.classList.remove("locked");
      loadTaxonomy();
      return render();
    }
    $("modeBadge").textContent = "Super Admin"; $("modeBadge").classList.add("live");
    const sdk = window.CAPLYNK_FIREBASE_SDK;
    const { initializeApp } = await import(sdk + "/firebase-app.js");
    const auth = await import(sdk + "/firebase-auth.js");
    const fs = await import(sdk + "/firebase-firestore.js");
    const st = await import(sdk + "/firebase-storage.js");
    const app = initializeApp(cfg); const db = fs.getFirestore(app); const a = auth.getAuth(app); const bucket = st.getStorage(app);
    const gate = $("gate"), gateErr = (m, kind) => { $("gateMsg").textContent = m || ""; $("gateMsg").className = "gate-msg " + (kind || ""); };
    let unsub = [];

    $("gateForm").onsubmit = async (e) => {
      e.preventDefault(); gateErr("");
      const email = $("gateEmail").value.trim(), pw = $("gatePw").value;
      if (email.toLowerCase() !== ADMIN_EMAIL) return gateErr("This page is for the CapLynk Super Admin only.");
      $("gateBtn").disabled = true;
      try { await auth.signInWithEmailAndPassword(a, email, pw); }
      catch (err) {
        gateErr(err.code === "auth/too-many-requests" ? "Too many attempts. Wait a few minutes and try again." : "That email and password don't match.");
      } finally { $("gateBtn").disabled = false; }
    };
    $("signOutBtn").onclick = () => auth.signOut(a);

    auth.onAuthStateChanged(a, async (user) => {
      unsub.forEach((f) => f()); unsub = [];
      const isAdmin = user && (user.email || "").toLowerCase() === ADMIN_EMAIL;
      if (user && !isAdmin) { await auth.signOut(a); return gateErr("That account isn't the Super Admin. Sign in with the admin email."); }
      if (user && !user.emailVerified) {
        await auth.sendEmailVerification(user).catch(() => {});
        await auth.signOut(a);
        return gateErr("One-time step: we've emailed a verification link to " + ADMIN_EMAIL + ". Open it, then sign in again.", "info");
      }
      gate.hidden = !!user; document.body.classList.toggle("locked", !user);
      if (!user) { state.candidates = []; state.roles = []; state.conversations = {}; return; }
      fb = { db, fs, user, st, bucket };
      $("whoami").textContent = user.email;
      const keepTyping = () => document.activeElement && ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement.tagName) && !document.activeElement.closest("dialog");
      // CVs are live: a candidate's upload shows up here without a refresh.
      let initial = true;
      unsub.push(fs.onSnapshot(fs.query(fs.collection(db, "cvs"), fs.orderBy("addedAt", "desc")), (snap) => {
        state.candidates = snap.docs.map((d) => d.data());
        if (!state.candidates.some((c) => c.id === state.candId)) state.candId = state.candidates[0]?.id || null;
        const fresh = snap.docChanges().filter((ch) => ch.type === "added").length;
        if (!initial && fresh) toast(fresh === 1 ? "A new CV just arrived." : fresh + " new CVs just arrived.");
        if (initial || state.tab !== "cvs" || !keepTyping()) render(); else renderUnread();
        initial = false;
      }, (e) => { console.error(e); toast("Couldn't load CVs. Check the Firestore rules are deployed."); }));
      const rs = await fs.getDocs(fs.collection(db, "roles")).catch(() => null);
      state.roles = rs ? rs.docs.map((d) => d.data()) : []; state.roleId = state.roles[0]?.id || null;
      state.rbRoleId = newestRole()?.id || null;
      await loadTaxonomy();
      // Use the Business API (and allow bulk sends) once its secrets and phone number ID are deployed.
      api("/api/whatsapp/send", { ping: true }).then((r) => { settings.waMode = r.configured ? "api" : "link"; if (state.tab === "wa") renderChats(); }).catch(() => {});
      unsub.push(fs.onSnapshot(fs.collection(db, "conversations"), (snap) => {
        snap.docChanges().forEach((ch) => { if (ch.type === "removed") delete state.conversations[ch.doc.id]; else state.conversations[ch.doc.id] = ch.doc.data(); });
        if (state.tab === "wa" && !keepTyping()) renderChats();
        else if (state.tab === "rb" && !keepTyping()) renderRoleBulk();
        else renderUnread();
      }));
      render();
    });
  }
  boot();
})();
