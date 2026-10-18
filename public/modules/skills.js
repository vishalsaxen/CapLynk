// CapLynk skills engine: SFIA catalogue, CV/JD heuristics, and candidate-to-role matching.
// Pure functions, shared by the browser (window.CapSkills) and Node tests (module.exports).
// The Cloud Function does the same extraction with Claude; these heuristics are the offline fallback.
(function (root) {
  // A working subset of SFIA 8 skills (code, name, category). Extend freely; codes are the join key.
  const SFIA = [
    ["PROG", "Programming/software development", "Development"],
    ["SWDN", "Software design", "Development"],
    ["ARCH", "Solution architecture", "Development"],
    ["TEST", "Testing", "Development"],
    ["SINT", "Systems integration and build", "Development"],
    ["RELM", "Release and deployment", "Delivery"],
    ["CFMG", "Configuration management", "Delivery"],
    ["DLMG", "Systems development management", "Delivery"],
    ["DBDS", "Database design", "Data"],
    ["DBAD", "Database administration", "Data"],
    ["DATM", "Data management", "Data"],
    ["DENG", "Data engineering", "Data"],
    ["DTAN", "Data modelling and design", "Data"],
    ["DATS", "Data science", "Data"],
    ["MLNG", "Machine learning", "Data"],
    ["BINT", "Business intelligence", "Data"],
    ["VISL", "Data visualisation", "Data"],
    ["ITOP", "Infrastructure operations", "Infrastructure"],
    ["SYSP", "System software", "Infrastructure"],
    ["NTDS", "Network design", "Infrastructure"],
    ["NTAS", "Network support", "Infrastructure"],
    ["SCTY", "Information security", "Security"],
    ["SCAD", "Security operations", "Security"],
    ["PENT", "Penetration testing", "Security"],
    ["VUAS", "Vulnerability assessment", "Security"],
    ["PRMG", "Project management", "Change"],
    ["PGMG", "Programme management", "Change"],
    ["BUAN", "Business situation analysis", "Change"],
    ["REQM", "Requirements definition and management", "Change"],
    ["BPRE", "Business process improvement", "Change"],
    ["HCEV", "User experience design", "Design"],
    ["URCH", "User research", "Design"],
    ["USUP", "Incident management", "Service"],
    ["PBMG", "Problem management", "Service"],
    ["CHMG", "Change control", "Service"],
    ["SLMO", "Service level management", "Service"],
    ["RLMT", "Stakeholder relationship management", "Relationships"],
    ["CNSL", "Consultancy", "Relationships"],
    ["QUAS", "Quality assurance", "Quality"],
    ["ITSP", "Strategic planning", "Strategy"],
    ["GOVN", "Governance", "Strategy"],
  ].map(([code, name, category]) => ({ code, name, category }));
  const BY_CODE = Object.fromEntries(SFIA.map((s) => [s.code, s]));

  const LEVELS = ["", "1 Follow", "2 Assist", "3 Apply", "4 Enable", "5 Ensure, advise", "6 Initiate, influence", "7 Set strategy"];

  // Phrases that evidence each SFIA skill in free text (lower case).
  const KEYWORDS = {
    PROG: ["python", "java", "javascript", "typescript", "c#", ".net", "c++", "golang", "ruby", "php", "kotlin", "swift", "react", "node.js", "nodejs", "angular", "vue", "django", "spring boot", "rust", "scala", "software developer", "software engineer", "full stack", "backend", "frontend"],
    SWDN: ["software design", "design patterns", "microservices", "api design", "object-oriented", "system design", "domain-driven"],
    ARCH: ["solution architect", "solutions architect", "solution architecture", "enterprise architecture", "togaf", "technical architect"],
    TEST: ["testing", "test automation", "qa automation", "selenium", "cypress", "playwright", "junit", "pytest", "test cases"],
    SINT: ["ci/cd", "jenkins", "github actions", "gitlab ci", "build pipeline", "systems integration"],
    RELM: ["release management", "deployment", "devops", "continuous delivery", "helm"],
    CFMG: ["configuration management", "ansible", "puppet", "chef"],
    DLMG: ["engineering manager", "development manager", "head of engineering", "delivery manager"],
    DBDS: ["database design", "schema design", "postgresql", "mysql", "sql server", "mongodb"],
    DBAD: ["database administration", "dba", "database administrator", "backup and recovery"],
    DATM: ["data management", "data governance", "master data", "data quality", "data catalogue", "data catalog"],
    DENG: ["data engineer", "data engineering", "etl", "elt", "spark", "airflow", "kafka", "databricks", "snowflake", "data pipeline", "dbt", "bigquery"],
    DTAN: ["data modelling", "data modeling", "dimensional model", "erd", "star schema"],
    DATS: ["data science", "data scientist", "statistics", "statistical", "pandas", "numpy", "r programming"],
    MLNG: ["machine learning", "deep learning", "tensorflow", "pytorch", "nlp", "llm", "scikit-learn", "computer vision", "generative ai"],
    BINT: ["business intelligence", "power bi", "tableau", "looker", "qlik", "reporting"],
    VISL: ["data visualisation", "data visualization", "dashboards", "dashboard", "d3.js"],
    ITOP: ["aws", "azure", "gcp", "google cloud", "cloud infrastructure", "kubernetes", "docker", "terraform", "sre", "site reliability", "infrastructure"],
    SYSP: ["linux", "unix", "windows server", "vmware", "operating systems"],
    NTDS: ["network design", "network architecture", "sd-wan", "routing and switching", "ccnp", "ccie"],
    NTAS: ["network support", "network engineer", "lan/wan", "ccna", "firewall"],
    SCTY: ["information security", "cyber security", "cybersecurity", "iso 27001", "security architecture", "cissp", "risk assessment"],
    SCAD: ["security operations", "soc analyst", "siem", "splunk", "incident response", "sentinel"],
    PENT: ["penetration testing", "pen testing", "pentest", "ethical hacking", "oscp", "burp suite"],
    VUAS: ["vulnerability assessment", "vulnerability scanning", "vulnerability management", "nessus", "qualys"],
    PRMG: ["project manager", "project management", "prince2", "pmp", "project delivery"],
    PGMG: ["programme manager", "program manager", "programme management", "program management", "msp"],
    BUAN: ["business analyst", "business analysis", "gap analysis", "as-is", "to-be"],
    REQM: ["requirements", "user stories", "backlog", "product owner", "acceptance criteria"],
    BPRE: ["process improvement", "lean", "six sigma", "bpmn", "process mapping"],
    HCEV: ["ux design", "ui design", "ui/ux", "figma", "interaction design", "user experience", "wireframes", "prototyping"],
    URCH: ["user research", "usability testing", "user interviews"],
    USUP: ["incident management", "service desk", "itil", "major incident"],
    PBMG: ["problem management", "root cause analysis"],
    CHMG: ["change control", "change advisory board", "cab"],
    SLMO: ["service level", "sla", "service delivery manager"],
    RLMT: ["stakeholder management", "stakeholder engagement", "client relationship", "account management"],
    CNSL: ["consultant", "consultancy", "consulting", "advisory"],
    QUAS: ["quality assurance", "iso 9001", "quality management", "audit"],
    ITSP: ["it strategy", "technology strategy", "digital strategy", "roadmap"],
    GOVN: ["it governance", "cobit", "corporate governance", "governance framework"],
  };

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const PATTERNS = Object.fromEntries(
    Object.entries(KEYWORDS).map(([code, words]) => [
      code,
      words.map((w) => ({ w, re: new RegExp("(^|[^a-z0-9+#])" + esc(w) + "($|[^a-z0-9+#])", "g") })),
    ])
  );

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

  // An overall SFIA level from seniority words and years; per-skill levels start here and the recruiter adjusts.
  function seniorityLevel(text, years) {
    const t = String(text || "").toLowerCase();
    let byTitle = 0;
    if (/\b(junior|graduate|trainee|intern)\b/.test(t)) byTitle = 2;
    if (/\bsenior\b/.test(t)) byTitle = 4;
    if (/\b(lead|principal|staff|architect|manager)\b/.test(t)) byTitle = 5;
    if (/\b(head of|director|chief|cto|cio|vp)\b/.test(t)) byTitle = 6;
    const y = years ?? 0;
    const byYears = y >= 15 ? 6 : y >= 10 ? 5 : y >= 6 ? 4 : y >= 2 ? 3 : y > 0 ? 2 : 3;
    return Math.min(7, Math.max(byTitle, byYears));
  }

  const NOT_NAME = /(curriculum|vitae|resume|résumé|profile|contact|address|phone|email|mobile|linkedin|summary|objective|page \d)/i;

  // Personal and contact details from CV text. Returns the same shape the Claude parser returns.
  function parseCvText(text) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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
    let name = labelled("name|full name|candidate name");
    let nameIdx = -1;
    if (!name) {
      nameIdx = lines.slice(0, 8).findIndex((l) => {
        const words = l.replace(/[,|•·].*$/, "").trim().split(/\s+/);
        return words.length >= 2 && words.length <= 4 && !NOT_NAME.test(l) && !/[@\d]/.test(l) &&
          words.every((w) => /^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(w));
      });
      if (nameIdx >= 0) name = lines[nameIdx].replace(/[,|•·].*$/, "").trim();
    }
    if (name && name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
    let headline = labelled("title|current role|position|headline");
    if (!headline && nameIdx >= 0) {
      const next = lines[nameIdx + 1] || "";
      if (next.length < 90 && !/[@]/.test(next) && !/\d{6,}/.test(next.replace(/\D/g, ""))) headline = next.replace(/\s*[|•·]\s*.*$/, "");
    }
    const location = labelled("location|address|based in|city");
    const years = yearsOfExperience(raw);
    const level = seniorityLevel(headline + " " + raw.slice(0, 1500), years);
    const skills = findSkills(raw).slice(0, 12).map((s) => ({
      code: s.code,
      level: Math.max(1, Math.min(7, level - (s.hits === 1 ? 1 : 0))),
      evidence: s.evidence.join(", "),
    }));
    return { name, email, phone, linkedin, location, headline, yearsExperience: years, skills, summary: "" };
  }

  // Required skills from a job description: strongest-evidenced skills, must-have when stated as required.
  function parseJobText(text) {
    const raw = String(text || "");
    const level = seniorityLevel(raw.slice(0, 600), yearsOfExperience(raw));
    const reqBlock = (raw.match(/(?:essential|required|must have|requirements)[\s\S]{0,1200}?(?:\n\s*\n|desirable|nice to have|$)/i) || [""])[0];
    const essential = new Set(findSkills(reqBlock).map((s) => s.code));
    return findSkills(raw).slice(0, 8).map((s) => ({ code: s.code, minLevel: level, mustHave: essential.has(s.code) }));
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

  const api = { SFIA, BY_CODE, LEVELS, KEYWORDS, findSkills, parseCvText, parseJobText, match, yearsOfExperience, seniorityLevel, toE164Digits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CapSkills = api;
})(typeof window !== "undefined" ? window : globalThis);
