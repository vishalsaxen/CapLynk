// CapLynk Super Admin workspace.
// CVs: every CV candidates upload on applicant.html (top-level cvs/), parsed here (Claude via /api/profiles, or the offline heuristics).
// WhatsApp: wa.me click-to-chat, with each conversation kept as a log that downloads as .txt.
// Tracker: per-candidate conversation with status, next step, due date, and close/reopen.
// Roles: SFIA skill profiles, ranked matches, and a printable client summary card.
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
  const state = { candidates: [], roles: [], conversations: {}, tab: "cvs", candId: null, chatId: null, roleId: null, wf: "open", q: "" };
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
    ["cvs", "wa", "roles"].forEach((t) => ($("view-" + t).hidden = t !== tab));
    render();
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  function render() {
    renderUnread();
    if (state.tab === "cvs") renderCandidates();
    if (state.tab === "wa") renderChats();
    if (state.tab === "roles") renderRoles();
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
    const valid = (p.skills || []).filter((s) => S.BY_CODE[s.code]).map((s) => ({ code: s.code, level: Math.max(1, Math.min(7, +s.level || 3)), evidence: s.evidence || "" }));
    Object.assign(c, {
      // The name a candidate signed up with beats the offline parser's guess; Claude reads the CV properly.
      name: (by === "claude" ? p.name || accountName(c) : accountName(c) || p.name) || c.name || "", email: p.email || c.email || accountEmail(c), phone: p.phone || "", location: p.location || "",
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
      $("candDetail").innerHTML = drop + `<div class="empty"><h3>No CVs yet</h3><p>CVs that candidates upload under Applicant Data show up here. Parse them to pull out contact details and an SFIA skill profile, then contact the candidate on WhatsApp.</p></div>`;
      return wireDrop();
    }
    const dup = duplicateOf(c);
    const conv = state.conversations[c.id];
    $("candDetail").innerHTML = drop + `
      <div class="title-row">
        <div><h1>${h(candLabel(c))}</h1><div class="sub">${h(c.fileName || "")}${c.ownerEmail && accountEmail(c) ? " · uploaded by " + h(accountEmail(c)) + " " + fmtTime(c.addedAt) : ""}${c.parsedBy ? " · parsed " + (c.parsedBy === "claude" ? "by Claude" : "by built-in parser") + " " + fmtTime(c.parsedAt) : ""}</div></div>
        <div class="row">
          <button class="btn ${c.status === "new" ? "" : "ghost"}" id="parseBtn" type="button">${c.status === "new" ? "Parse CV" : "Parse again"}</button>
          <button class="btn wa" id="waBtn" type="button" ${c.phone ? "" : "disabled title='Add a phone number first'"}>WhatsApp${conv ? (conv.status === "closed" ? " (closed)" : "") : ""}</button>
          ${c.storagePath ? `<button class="btn ghost" id="cvDlBtn" type="button" title="The file exactly as it was uploaded">Download ${fileKind(c)}</button>`
            : `<label class="btn ghost" for="attachFile" title="This CV arrived before original files were kept. Attach the PDF or Word file to store it with the CV.">Attach original</label><input id="attachFile" type="file" accept=".pdf,.doc,.docx,.txt,.md" hidden>`}
          <button class="btn ghost" id="txtDlBtn" type="button" title="The text CapLynk read from the CV">Download .txt</button>
          <button class="btn danger" id="delBtn" type="button">Delete</button>
        </div>
      </div>
      ${c.status === "new" ? '<div class="warn">Not parsed yet. Parse to fill in contact details and skills, or type them in yourself.</div>' : ""}
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
      <div class="card"><h3>Skill profile (SFIA) <button class="btn ghost sm" id="addSkillBtn" type="button">Add skill</button></h3>
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
  function field(key, label, val, type = "text") { return `<label class="f">${label}<input data-f="${key}" type="${type}" value="${h(val ?? "")}"></label>`; }
  function unusedCode(list) { const used = new Set(list.map((s) => s.code)); return (S.SFIA.find((s) => !used.has(s.code)) || S.SFIA[0]).code; }
  function skillOptions(sel) {
    let cat = "", out = "";
    for (const s of S.SFIA) { if (s.category !== cat) { out += (cat ? "</optgroup>" : "") + `<optgroup label="${s.category}">`; cat = s.category; } out += `<option value="${s.code}" ${s.code === sel ? "selected" : ""}>${s.name} (${s.code})</option>`; }
    return out + "</optgroup>";
  }
  function levelOptions(sel) { return S.LEVELS.slice(1).map((l, i) => `<option value="${i + 1}" ${+sel === i + 1 ? "selected" : ""}>${l}</option>`).join(""); }
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
  }

  document.querySelectorAll("[data-wf]").forEach((b) => (b.onclick = () => { state.wf = b.dataset.wf; renderChats(); }));

  function renderChats() {
    document.querySelectorAll("[data-wf]").forEach((b) => b.classList.toggle("ghost", b.dataset.wf !== state.wf));
    const t = today();
    const convs = Object.values(state.conversations)
      .filter((c) => state.candidates.some((x) => x.id === c.id))
      .filter((c) => state.wf === "all" || (state.wf === "closed" ? c.status === "closed" : c.status !== "closed") && (state.wf !== "next" || (c.nextStepDue && c.nextStepDue <= t)))
      .sort((a, b) => (b.lastAt || b.createdAt || "").localeCompare(a.lastAt || a.createdAt || ""));
    $("chatList").innerHTML = convs.length ? convs.map((conv) => {
      const c = state.candidates.find((x) => x.id === conv.id);
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
    const c = conv && state.candidates.find((x) => x.id === conv.id);
    if (!conv || !c) { $("chatDetail").innerHTML = `<div class="empty"><h3>WhatsApp tracker</h3><p>Every message you send to a candidate lands here with its replies, a next step and a due date. Close a chat when it's no longer needed; closed chats can't be messaged until you reopen them.</p></div>`; return; }
    if (conv.unread) { conv.unread = false; save("conversations", conv); renderUnread(); }

    const phone = S.toE164Digits(c.phone, settings.cc);
    const closed = conv.status === "closed";
    const [label, tone] = convState(conv);
    const role = state.roles.find((r) => r.id === conv.roleId);
    $("chatDetail").innerHTML = `
      <div class="chat-head">
        <div class="title-row" style="margin:0">
          <div><h1 style="font-size:21px">${h(candLabel(c))} <span class="chip ${tone}" style="vertical-align:middle">${label}</span></h1>
            <div class="sub">${phone ? "+" + h(phone) : "No phone number"} · ${settings.waMode === "api" ? "Business API" : "WhatsApp link"}</div></div>
          <div class="row">
            <button class="btn ghost sm" id="viewCandBtn" type="button">View CV</button>
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
          <div class="msg ${m.dir}">${h(m.text)}<div class="meta">${fmtTime(m.at)}${m.dir === "out" ? " · " + h(m.status || (m.via === "link" ? "opened in WhatsApp" : "sent")) : m.via === "manual" ? " · logged" : ""}</div></div>`).join("")}
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
    $("viewCandBtn").onclick = () => { state.candId = c.id; setTab("cvs"); };
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
    $("sendBtn").onclick = () => sendWhatsApp(conv, c, phone);
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
      (m.dir === "out" && m.status ? ` (${m.status})` : m.via === "manual" ? " (logged by admin)" : ""));
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

  async function sendWhatsApp(conv, c, phone) {
    const text = $("msgText").value.trim();
    if (!text) return toast("Write a message first.");
    if (conv.status === "closed") return toast("This chat is closed. Reopen it to send.");
    const btn = $("sendBtn"); btn.disabled = true;
    const lastIn = [...conv.messages].reverse().find((m) => m.dir === "in");
    const inWindow = lastIn && Date.now() - new Date(lastIn.at).getTime() < 24 * 3600e3;
    if (settings.waMode === "api") {
      try {
        const r = await api("/api/whatsapp/send", { candidateId: c.id, to: phone, text, useTemplate: !inWindow, candidateName: c.name || "" });
        conv.messages.push({ id: r.messageId || uid(), dir: "out", text, at: now(), via: "api", status: "sent" }); conv.lastAt = now();
        state.conversations[conv.id] = conv; // the server stores the message; the live listener refreshes it
        renderChats(); return toast("Sent on WhatsApp.");
      } catch (e) {
        toast("Business API unavailable (" + (e.message || "error").slice(0, 80) + "). Opening WhatsApp instead.");
      }
    }
    window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(text), "_blank", "noopener");
    conv.messages.push({ id: uid(), dir: "out", text, at: now(), via: "link", status: "opened in WhatsApp" }); conv.lastAt = now();
    await save("conversations", conv); renderChats();
  }

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
    if (!r) { $("roleDetail").innerHTML = `<div class="empty"><h3>Match candidates to a role</h3><p>Create a role, paste the job description, and CapLynk builds its SFIA skill profile, ranks your parsed candidates, and lays out a summary card for the client.</p><button class="btn" id="emptyRole" type="button">New role</button></div>`; $("emptyRole").onclick = () => $("newRoleBtn").click(); return; }
    r.shortlist ||= []; r.summaries ||= {};
    const parsed = state.candidates.filter((c) => c.status === "parsed" || (c.skills || []).length);
    const ranked = parsed.map((c) => ({ c, m: S.match(c, r) })).sort((a, b) => b.m.score - a.m.score);
    $("roleDetail").innerHTML = `
      <div class="title-row"><div><h1>${h(r.title)}</h1><div class="sub">${h([r.client, r.location].filter(Boolean).join(" · "))}</div></div>
        <div class="row"><button class="btn" id="presentBtn" type="button" ${r.shortlist.length ? "" : "disabled"}>Present ${r.shortlist.length || ""} to client</button><button class="btn danger" id="delRoleBtn" type="button">Delete role</button></div></div>
      <div class="card"><h3>Role</h3>
        <div class="grid">
          <label class="f">Job title<input data-r="title" value="${h(r.title)}"></label>
          <label class="f">Client<input data-r="client" value="${h(r.client)}"></label>
          <label class="f">Location<input data-r="location" value="${h(r.location)}"></label>
        </div>
        <label class="f" style="margin-top:12px">Job description<textarea data-r="description" rows="6" placeholder="Paste the client's job description">${h(r.description)}</textarea></label>
        <div class="row" style="margin-top:10px">
          <label class="btn ghost sm" for="jdFile">Upload JD file</label>
          <input id="jdFile" type="file" accept=".pdf,.docx,.txt,.md" hidden>
          <button class="btn ghost sm" id="extractBtn" type="button">Build skill profile from description</button>
        </div>
      </div>
      <div class="card"><h3>Job skill profile (SFIA) <button class="btn ghost sm" id="addReqBtn" type="button">Add skill</button></h3>${skillTable(r.skills, "role")}</div>
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
      if (!desc) return toast("Paste the job description first.");
      let skills;
      try { skills = (await api("/api/profiles", { action: "job", text: desc })).profile.skills; }
      catch { skills = S.parseJobText(desc); }
      r.skills = skills.filter((s) => S.BY_CODE[s.code]).map((s) => ({ code: s.code, minLevel: Math.max(1, Math.min(7, +s.minLevel || 3)), mustHave: !!s.mustHave }));
      await save("roles", r); renderRoles(); toast(r.skills.length ? "Skill profile built. Adjust levels and must-haves as needed." : "No SFIA skills recognised. Add them by hand.");
    };
    $("roleDetail").querySelectorAll("[data-sl]").forEach((el) => (el.onchange = () => {
      const id = el.dataset.sl; r.shortlist = el.checked ? [...new Set([...r.shortlist, id])] : r.shortlist.filter((x) => x !== id);
      save("roles", r); renderRoles();
    }));
    $("roleDetail").querySelectorAll("[data-wa]").forEach((b) => (b.onclick = () => { const conv = ensureConv(b.dataset.wa); if (!conv.roleId) conv.roleId = r.id; openChat(b.dataset.wa); }));
    $("presentBtn").onclick = () => openClientCard(r);
    $("delRoleBtn").onclick = async () => { if (!confirm("Delete the role " + r.title + "?")) return; await remove("roles", r.id); state.roleId = state.roles[0]?.id || null; renderRoles(); };
  }

  function templateSummary(c, r, m) {
    const strong = m.rows.filter((x) => x.met).sort((a, b) => b.level - a.level).slice(0, 3).map((x) => x.name.toLowerCase());
    const gaps = m.rows.filter((x) => !x.met).map((x) => x.name.toLowerCase());
    const yrs = c.yearsExperience ? ` with ${c.yearsExperience} years' experience` : "";
    return `${first(c.name)} is ${/^[aeiou]/i.test(c.headline || "") ? "an" : "a"} ${c.headline || "candidate"}${yrs}${c.location ? ", based in " + c.location : ""}. ` +
      `Against the ${r.title} profile they meet ${m.met} of ${m.rows.length} required skills at or above the SFIA level asked for` +
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
        <table><thead><tr><th>Skill (SFIA)</th><th>Required</th><th>Candidate</th><th></th></tr></thead><tbody>
          ${m.rows.map((x) => `<tr><td>${h(x.name)} <span style="color:#566070;font-size:12px">${x.code}${x.mustHave ? " · essential" : ""}</span></td><td>Level ${x.need}</td><td>${x.level ? "Level " + x.level : "Not evidenced"}</td><td class="${x.met ? "yes" : "no"}">${x.met ? "✓ Meets" : "Gap"}</td></tr>`).join("")}
        </tbody></table>
        ${other ? `<div class="cc-foot"><strong>Also brings:</strong> ${h(other)}</div>` : ""}
        <div class="cc-foot">Skill levels follow SFIA (1 Follow to 7 Set strategy). Presented by ${h(settings.sender || "Gaplyn Services")}.</div>
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

  // ---------- settings ----------
  $("settingsBtn").onclick = () => {
    $("setCc").value = settings.cc; $("setSender").value = settings.sender;
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
      state.candId = state.candidates[0]?.id || null; state.roleId = state.roles[0]?.id || null;
      $("gate").hidden = true; document.body.classList.remove("locked");
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
      unsub.push(fs.onSnapshot(fs.collection(db, "conversations"), (snap) => {
        snap.docChanges().forEach((ch) => { if (ch.type === "removed") delete state.conversations[ch.doc.id]; else state.conversations[ch.doc.id] = ch.doc.data(); });
        if (state.tab === "wa" && !keepTyping()) renderChats(); else renderUnread();
      }));
      render();
    });
  }
  boot();
})();
