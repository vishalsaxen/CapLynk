// CapLynk skills engine: the CapLynk Capability Taxonomy, CV/JD heuristics, and candidate-to-role matching.
// Pure functions, shared by the browser (window.CapSkills) and Node tests (module.exports).
// The taxonomy is Gaplyn's own (Excel workbook, imported on admin.html and kept in Firestore), so it is
// loaded at runtime with load(); nothing from it is hard-coded here. The Cloud Function does the same
// extraction with Claude; these heuristics are the offline fallback.
(function (root) {
  // Filled by load(). Kept as the same objects so callers holding S.SKILLS / S.BY_CODE see the update.
  const SKILLS = [];          // { code, name, domain, category, type, description, aliases[] }
  const BY_CODE = {};
  const ROLES = [];           // { id, name, family, alt[], summary, skills: [{ id, imp, lv: [junior, mid, senior, lead] }] }
  const LEVELS = [""];        // LEVELS[n] = "Ln Name", n = 1..6
  const LEVEL_INFO = [];      // [{ level, name, description }]
  const META = { version: "", title: "", loaded: false };
  const BANDS = ["Junior", "Mid", "Senior", "Lead"];
  let PATTERNS = {};

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const splitList = (v) => String(v ?? "").split(/;/).map((x) => x.trim()).filter(Boolean);
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };   // "-" means not expected: 0

  // Turns the workbook's sheets ({ sheetName: [[cell, ...], ...] }, header row first) into the taxonomy object.
  function fromSheets(sheets) {
    const need = ["Proficiency Levels", "Skills", "Roles", "Role Skill Map"];
    const missing = need.filter((n) => !sheets[n]);
    if (missing.length) throw new Error("The workbook is missing the sheet" + (missing.length > 1 ? "s " : " ") + missing.join(", ") + ".");
    const rows = (n) => {
      const [hdr, ...rest] = sheets[n];
      const idx = Object.fromEntries((hdr || []).map((hname, i) => [String(hname ?? "").trim().toLowerCase(), i]));
      return rest.filter((r) => r && r.some((c) => c !== null && c !== undefined && c !== "")).map((r) => (key) => r[idx[key.toLowerCase()]]);
    };
    const about = (sheets.About || []).map((r) => String(r?.[0] ?? ""));
    const version = (about.join(" ").match(/Version\s+([\w.]+)/i) || [])[1] || "";
    const levels = rows("Proficiency Levels").map((g) => ({ level: num(String(g("Level")).replace(/\D/g, "")), name: String(g("Name") ?? ""), description: String(g("Description") ?? "") }))
      .filter((l) => l.level > 0).sort((a, b) => a.level - b.level);
    const skills = rows("Skills").map((g) => ({
      code: String(g("Skill ID") ?? "").trim(), name: String(g("Skill") ?? "").trim(), domain: String(g("Domain") ?? ""), category: String(g("Category") ?? ""),
      type: String(g("Type") ?? ""), description: String(g("Description") ?? ""), aliases: splitList(g("Aliases and keywords")),
    })).filter((x) => x.code && x.name);
    const roleSkills = {};
    for (const g of rows("Role Skill Map")) {
      const id = String(g("Role ID") ?? "").trim(), skill = String(g("Skill ID") ?? "").trim();
      if (!id || !skill) continue;
      (roleSkills[id] ||= []).push({ id: skill, imp: String(g("Importance") ?? ""), lv: [g("Junior level"), g("Mid level"), g("Senior level"), g("Lead level")].map(num) });
    }
    const roles = rows("Roles").map((g) => {
      const id = String(g("Role ID") ?? "").trim();
      return { id, name: String(g("Role") ?? "").trim(), family: String(g("Role family") ?? ""), alt: splitList(g("Alternate titles")), summary: String(g("Summary") ?? ""), skills: roleSkills[id] || [] };
    }).filter((r) => r.id && r.name);
    if (!skills.length) throw new Error("No skills found on the Skills sheet.");
    if (levels.length < 2) throw new Error("No proficiency levels found on the Proficiency Levels sheet.");
    return { title: about[0] || "CapLynk Capability Taxonomy", version, levels, skills, roles };
  }

  // Phrases that evidence a skill in free text: its name plus its aliases. Two-letter aliases ("ID", "QA")
  // match too much ordinary text, so they are left out.
  function keywordsFor(s) {
    return [...new Set([s.name, ...s.aliases].map((w) => w.toLowerCase().trim()).filter((w) => w.length >= 3))];
  }

  function load(tax) {
    SKILLS.splice(0, SKILLS.length, ...(tax?.skills || []));
    for (const k of Object.keys(BY_CODE)) delete BY_CODE[k];
    for (const s of SKILLS) BY_CODE[s.code] = s;
    ROLES.splice(0, ROLES.length, ...(tax?.roles || []));
    LEVEL_INFO.splice(0, LEVEL_INFO.length, ...(tax?.levels || []));
    LEVELS.splice(0, LEVELS.length, "", ...LEVEL_INFO.map((l) => "L" + l.level + " " + l.name));
    Object.assign(META, { version: tax?.version || "", title: tax?.title || "", loaded: SKILLS.length > 0 });
    PATTERNS = Object.fromEntries(SKILLS.map((s) => [s.code, keywordsFor(s).map((w) => ({ w, re: new RegExp("(^|[^a-z0-9+#])" + esc(w) + "($|[^a-z0-9+#])", "g") }))]));
    return META;
  }
  const maxLevel = () => Math.max(1, LEVELS.length - 1);

  function findSkills(text) {
    const t = " " + String(text || "").toLowerCase() + " ";
    const out = [];
    for (const [code, pats] of Object.entries(PATTERNS)) {
      let hits = 0; const ev = [];
      for (const { w, re } of pats) {
        const n = (t.match(re) || []).length;
        if (n) { hits += n; ev.push(w); }
      }
      if (hits) out.push({ code, hits, evidence: ev.slice(0, 5) });
    }
    return out.sort((a, b) => b.hits - a.hits);
  }

  function yearsOfExperience(text) {
    const m = [...String(text || "").matchAll(/(\d{1,2})\s*\+?\s*(?:years|yrs)(?:'|’)?\s*(?:of\s+)?(?:experience|exp)?/gi)].map((x) => +x[1]);
    return m.length ? Math.min(Math.max(...m), 45) : null;
  }

  // Seniority band from title words and years, using the taxonomy's bands: Junior 0-2 years, Mid 3-5, Senior 6-9, Lead 10+.
  function seniorityBand(text, years) {
    const t = String(text || "").toLowerCase();
    let byTitle = -1;
    if (/\b(junior|graduate|trainee|intern|associate|fresher|entry[- ]level)\b/.test(t)) byTitle = 0;
    if (/\bsenior\b|\bsr\.?\s/.test(t)) byTitle = 2;
    if (/\b(lead|principal|staff|head of|director|chief|vp)\b/.test(t)) byTitle = Math.max(byTitle, 3);
    const y = years ?? null;
    const byYears = y === null ? 1 : y >= 10 ? 3 : y >= 6 ? 2 : y >= 3 ? 1 : 0;
    return byTitle >= 0 ? Math.max(byTitle, y === null ? byTitle : byYears) : byYears;
  }
  // A starting proficiency level for a candidate (Junior L2, Mid L3, Senior L4, Lead L5); the recruiter adjusts.
  // Matches the workbook's Role Skill Map, where Core skills sit at L3 Junior, L4 Mid, L5 Senior and L5 Lead.
  function seniorityLevel(text, years) { return Math.min(maxLevel(), [3, 4, 5, 5][seniorityBand(text, years)]); }

  const NOT_NAME = /(curriculum|vitae|resume|résumé|profile|contact|address|phone|email|mobile|linkedin|summary|objective|page \d)/i;
  // CV section headings ("Core Skills", "Work Experience") look like names to a naive parser.
  const HEADING = /\b(skills?|experience|education|projects?|certifications?|achievements?|core|professional|work|career|technical|competenc(y|ies)|expertise|languages?|responsibilit(y|ies)|highlights|key|areas|tools|about|personal|details|declaration|references?|hobbies|interests|strengths|qualifications?|employment|history|training|awards|accomplishments|overview|internships?|publications)\b/i;
  const ROLE_WORD = /\b(manager|designer|engineer|developer|analyst|consultant|lead|specialist|architect|officer|director|executive|coordinator|administrator|scientist|tester|writer|trainer|head|associate|intern|programmer|recruiter|accountant|strategist)\b/i;
  const PLACE = /^([A-Za-z .'-]{2,40}),\s*(India|United Kingdom|UK|England|Scotland|Wales|Ireland|USA|United States|US|UAE|Dubai|Singapore|Canada|Australia|Germany|France|Netherlands|Malaysia|Philippines|Sri Lanka|Nepal|Bangladesh|Pakistan|South Africa|New Zealand|[A-Z][a-z]+ Pradesh|Maharashtra|Karnataka|Telangana|Tamil Nadu|Kerala|Haryana|Delhi|Gujarat|Rajasthan|West Bengal|Punjab)\b/i;
  const titleCase = (t) => t.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
  const clean = (l) => l.replace(/^[\s\-–—•·*▪●◦>]+/, "").trim();

  function parseCvText(text, fileName) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/).map(clean).filter(Boolean);
    const email = (raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
    const phone = ((raw.match(/(?:\+|00)?\d[\d \t().-]{7,}\d/g) || []).find((p) => {
      const d = p.replace(/\D/g, "");
      return d.length >= 10 && d.length <= 15 && !/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(p.trim());
    }) || "").trim();
    const linkedin = (raw.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i) || [""])[0];
    const labelled = (label) => {
      const m = raw.match(new RegExp("^\\s*(?:" + label + ")\\s*[:\\-–]\\s*(.+)$", "im"));
      return m ? m[1].trim() : "";
    };
    // Hints from the file name ("Hasheena_Resume.docx") and the email ("haseena917@...").
    const fileWords = String(fileName || "").replace(/\.[a-z0-9]+$/i, "").split(/[^A-Za-z]+/)
      .filter((w) => w.length > 1 && !/^(cv|resume|résumé|updated|final|new|latest|profile|copy|doc|v\d*)$/i.test(w));
    const mailWord = email.split("@")[0].replace(/[^a-z]/gi, "").toLowerCase();
    const hinted = (l) => l.toLowerCase().split(/\s+/).some((w) => w.length > 2 &&
      (fileWords.some((f) => f.toLowerCase() === w) || (mailWord.length > 2 && (mailWord.startsWith(w) || w.startsWith(mailWord.slice(0, 4))))));
    const nameLike = (l) => {
      const words = l.replace(/[,|•·].*$/, "").trim().split(/\s+/);
      return words.length >= 1 && words.length <= 4 && !NOT_NAME.test(l) && !HEADING.test(l) && !ROLE_WORD.test(l) &&
        !/[@\d:]/.test(l) && words.every((w) => /^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(w));
    };

    let name = labelled("name|full name|candidate name");
    let nameIdx = -1;
    if (!name) {
      const top = lines.slice(0, 12);
      // A line that matches the file name or email wins; otherwise the first two-to-four-word name-like line.
      nameIdx = top.findIndex((l) => nameLike(l) && hinted(l));
      if (nameIdx < 0) nameIdx = top.findIndex((l) => nameLike(l) && l.split(/\s+/).length >= 2);
      if (nameIdx >= 0) name = lines[nameIdx].replace(/[,|•·].*$/, "").trim();
      else if (fileWords.length) name = fileWords.slice(0, 3).join(" ");
    }
    if (name && (name === name.toUpperCase() || name === name.toLowerCase())) name = titleCase(name);

    let headline = labelled("title|current role|current title|position|headline|designation");
    if (!headline) {
      const near = nameIdx >= 0 ? lines.slice(nameIdx + 1, nameIdx + 4) : [];
      const pick = (l) => l.length < 90 && ROLE_WORD.test(l) && !/[@]/.test(l) && !/\d{6,}/.test(l.replace(/\D/g, "")) && !/^(skills?|experience)\b/i.test(l);
      headline = near.find(pick) || lines.slice(0, 15).find(pick) || "";
      headline = headline.replace(/\s*[|•·].*$/, "").replace(/\s+(with|having)\s.*$/i, "").replace(/[.,;:]+$/, "").trim();
    }
    let location = labelled("location|address|based in|city|current location");
    if (!location) {
      for (const l of lines.slice(0, 15)) {
        for (const part of l.split(/\s*[|•·]\s*/)) { const m = part.match(PLACE); if (m) { location = m[0].trim(); break; } }
        if (location) break;
      }
    }
    const years = yearsOfExperience(raw);
    const level = seniorityLevel(headline + " " + raw.slice(0, 1500), years);
    const skills = findSkills(raw).slice(0, 12).map((s) => ({
      code: s.code,
      level: Math.max(1, Math.min(maxLevel(), level - (s.hits === 1 ? 1 : 0))),
      evidence: s.evidence.join(", "),
    }));
    return { name, email, phone, linkedin, location, headline, yearsExperience: years, skills, summary: "" };
  }

  // The taxonomy role a job title or description names, by role name or alternate title (longest match wins).
  function findRole(text) {
    const t = " " + String(text || "").toLowerCase().replace(/\s+/g, " ") + " ";
    let best = null, bestLen = 0;
    for (const r of ROLES) {
      for (const title of [r.name, ...r.alt]) {
        const w = title.toLowerCase().trim();
        if (w.length < 4 || w.length <= bestLen) continue;
        if (new RegExp("(^|[^a-z0-9])" + esc(w) + "($|[^a-z0-9])").test(t)) { best = r; bestLen = w.length; }
      }
    }
    return best;
  }
  // A role's skill profile at one band (0 Junior .. 3 Lead): Core skills are must-haves; skills not expected at the band are left out.
  function roleProfile(role, band) {
    return (role?.skills || []).filter((x) => BY_CODE[x.id] && x.lv[band] > 0)
      .map((x) => ({ code: x.id, minLevel: Math.min(maxLevel(), x.lv[band]), mustHave: x.imp === "Core" }));
  }

  // Required skills from a job description. When the title or text names a taxonomy role, its mapped skills
  // at the right band come first; skills the JD mentions beyond those are added at the JD's level.
  function parseJobText(text, title) {
    const raw = String(text || "");
    const years = yearsOfExperience(raw);
    const band = seniorityBand((title || "") + " " + raw.slice(0, 600), years);
    const role = findRole(title || "") || findRole(raw.slice(0, 400));
    const fromRole = roleProfile(role, band);
    const have = new Set(fromRole.map((s) => s.code));
    const reqBlock = (raw.match(/(?:essential|required|must have|requirements)[\s\S]{0,1200}?(?:\n\s*\n|desirable|nice to have|$)/i) || [""])[0];
    const essential = new Set(findSkills(reqBlock).map((s) => s.code));
    const level = Math.min(maxLevel(), band + 2);
    const extra = findSkills(raw).filter((s) => !have.has(s.code)).slice(0, role ? 4 : 10)
      .map((s) => ({ code: s.code, minLevel: level, mustHave: essential.has(s.code) }));
    return Object.assign([...fromRole, ...extra], { role: role ? { id: role.id, name: role.name } : null, band: BANDS[band] });
  }

  // Score 0-100: each required skill earns credit up to its minimum level; must-haves count double.
  function match(candidate, role) {
    const req = role.skills || [];
    const have = Object.fromEntries((candidate.skills || []).map((s) => [s.code, +s.level || 0]));
    let total = 0, got = 0;
    const rows = req.map((r) => {
      const w = r.mustHave ? 2 : 1, need = +r.minLevel || 1, lvl = have[r.code] || 0;
      total += w; got += w * Math.min(lvl / need, 1);
      return { code: r.code, name: BY_CODE[r.code]?.name || r.code, need, level: lvl, mustHave: !!r.mustHave, met: lvl >= need };
    });
    const score = total ? Math.round((got / total) * 100) : 0;
    const missingMust = rows.filter((r) => r.mustHave && !r.level);
    return { score, rows, met: rows.filter((r) => r.met).length, missingMust };
  }

  // Phone numbers in international digits-only form for wa.me and the Cloud API.
  function toE164Digits(phone, defaultCc) {
    let p = String(phone || "").trim();
    if (!p) return "";
    if (p.startsWith("00")) p = "+" + p.slice(2);
    const d = p.replace(/\D/g, "");
    if (p.startsWith("+")) return d;
    if (d.startsWith("0") && defaultCc) return String(defaultCc).replace(/\D/g, "") + d.replace(/^0+/, "");
    return d;
  }

  const api = { SKILLS, BY_CODE, ROLES, LEVELS, LEVEL_INFO, META, BANDS, fromSheets, load, findSkills, findRole, roleProfile, parseCvText, parseJobText, match, yearsOfExperience, seniorityBand, seniorityLevel, toE164Digits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CapSkills = api;
})(typeof window !== "undefined" ? window : globalThis);
