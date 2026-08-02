/**
 * draftingLab.controller.js — v3 (three-step learning flow)
 * Contract: _contracts/04-drafting-lab.md
 *
 * Flow:
 *   1. GET  /library                    → Step 1 (View & Learn): anatomy + real
 *          Delhi/Maharashtra specimens from draftLibrary.data.js, plus a
 *          presigned S3 GET url for every specimen that has a real stored PDF.
 *          No AI, unlimited, zero cost.
 *   2. GET  /options                    → the 5 draft types, for Step 2's picker.
 *   3. POST /case-study {template_type} → 50/month (featureLimitMonthly in routes).
 *          Creates a `sessions` row (feature_name='drafting_lab', status
 *          'preparing'), enqueues the worker's Call 1 (generate a case).
 *   4. GET  /case-study/result/:id      → poll; once 'active', returns the
 *          case facts + the fixed fields to fill (same blanks/template
 *          approach the founder-provided zip used).
 *   5. POST /case-study/submit {doc_id, fields} → assembles the draft
 *          server-side, rejects an oversized draft BEFORE billing/enqueue,
 *          enqueues the worker's Call 2 (score the draft).
 *   6. GET  /case-study/score/:id       → poll; once 'complete', the scored
 *          lawyer-style critique (no model draft to compare against).
 *   7. GET  /history                    → past exercises (metadata only).
 *
 * Reuses the `sessions` table (not `documents` — see migration
 * 20260723_drafting_lab_v3.sql for why). Every session query filters
 * user_id + college_id. No refund of the daily slot on a failed
 * generation/scoring call — matches Court Simulation's and AI Interviewer's
 * established no-refund pattern (this was the contract's "confirm at build
 * time" open item; resolved here for consistency across all three AI
 * features rather than reintroducing the founder-provided zip's one-off
 * manual-refund logic).
 */
const AWS = require('aws-sdk');
const { Queue } = require('bullmq');
const { draftLibrary } = require('../data/draftLibrary.data');
// pool: kept for ai_usage_log inserts only (no RLS policy on that table — see
// migrations/20260726_rls_policies.sql). sessions queries below are
// RLS-protected, so those go through queryAsCollege with college_id from
// req.user (verified JWT via auth.middleware.js).
const { pool, queryAsCollege } = require('../config/db');
const draftQueue = new Queue('drafting-lab', { connection: require('../config/redisConnection') });

const s3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: 'v4' });
const BUCKET = process.env.S3_BUCKET_FILES;

const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

// ── The 5 draft types: label + fixed fields ("blanks") + the {{blank}} template
// each case assembles into. Carried over from the founder-provided zip's
// DRAFT_TYPES (same content, same {{blank}}-substitution approach) — this is
// Step 2's base, separate from Step 1's draftLibrary.data.js real specimens.
const DRAFT_TYPES = {
  bail_application: {
    label: 'Bail Application (S.483 BNSS)',
    blanks: [
      { id: 'court_name', label: 'Court', hint: 'e.g. The Sessions Judge, ____' },
      { id: 'fir_number', label: 'FIR No.', hint: 'e.g. 145/2026' },
      { id: 'police_station', label: 'Police Station', hint: '' },
      { id: 'offence_sections', label: 'Offence sections (BNS)', hint: 'e.g. 115(2), 351(2) BNS' },
      { id: 'accused_name', label: 'Accused name', hint: '' },
      { id: 'accused_address', label: 'Accused address', hint: '' },
      { id: 'arrest_date', label: 'Date of arrest', hint: '' },
      { id: 'grounds', label: 'Main ground for bail', hint: 'one or two sentences' },
      { id: 'prayer', label: 'Prayer', hint: 'the relief sought' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`BAIL APPLICATION UNDER SECTION 483 BNSS, 2023
IN THE COURT OF {{court_name}}
Bail Application No. ______ of 2026
(Arising out of FIR No. {{fir_number}}, P.S. {{police_station}}, for offences u/s {{offence_sections}})

IN THE MATTER OF:
{{accused_name}}, R/o {{accused_address}} ..... Applicant / Accused
VERSUS
State ..... Respondent

MOST RESPECTFULLY SHOWETH:
1. That the applicant was arrested on {{arrest_date}} and has been in judicial custody since then.
2. That the applicant is innocent and has been falsely implicated in the present case.
3. That {{grounds}}.
4. That the applicant undertakes to cooperate with the trial and shall not tamper with the evidence or influence any witness.

PRAYER: {{prayer}}

Place: {{place}}                                  Applicant, through Counsel
Date: {{date}}`,
  },

  anticipatory_bail: {
    label: 'Anticipatory Bail (S.482 BNSS)',
    blanks: [
      { id: 'court_name', label: 'Court', hint: 'e.g. The Sessions Judge, ____' },
      { id: 'fir_number', label: 'FIR No.', hint: '' },
      { id: 'police_station', label: 'Police Station', hint: '' },
      { id: 'offence_sections', label: 'Offence sections (BNS)', hint: '' },
      { id: 'applicant_name', label: 'Applicant name', hint: '' },
      { id: 'applicant_address', label: 'Applicant address', hint: '' },
      { id: 'apprehension_grounds', label: 'Why arrest is apprehended', hint: 'the ground of apprehension' },
      { id: 'prayer', label: 'Prayer', hint: '' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`APPLICATION FOR ANTICIPATORY BAIL UNDER SECTION 482 BNSS, 2023
IN THE COURT OF {{court_name}}
Anticipatory Bail Application No. ______ of 2026
(FIR No. {{fir_number}}, P.S. {{police_station}}, u/s {{offence_sections}})

{{applicant_name}}, R/o {{applicant_address}} ..... Applicant
VERSUS   State ..... Respondent

MOST RESPECTFULLY SHOWETH:
1. That the applicant apprehends arrest because {{apprehension_grounds}}.
2. That the applicant is innocent and has been falsely implicated.
3. That the applicant is ready and willing to cooperate with the investigation.
4. That there is no likelihood of the applicant absconding or tampering with the evidence.

PRAYER: {{prayer}}

Place: {{place}}                                  Applicant, through Counsel
Date: {{date}}`,
  },

  vakalatnama: {
    label: 'Vakalatnama',
    blanks: [
      { id: 'court_name', label: 'Court', hint: '' },
      { id: 'case_number', label: 'Case No.', hint: '' },
      { id: 'party_name', label: 'Party (executant) name', hint: '' },
      { id: 'party_capacity', label: 'Party capacity', hint: 'Plaintiff / Defendant / Accused / Petitioner' },
      { id: 'advocate_name', label: 'Advocate name', hint: '' },
      { id: 'advocate_enrolment', label: 'Advocate enrolment no.', hint: '' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`VAKALATNAMA
IN THE COURT OF {{court_name}}
Case No. {{case_number}}

I, {{party_name}}, the {{party_capacity}} in the above case, do hereby appoint and retain
{{advocate_name}} (Enrolment No. {{advocate_enrolment}}), Advocate, to appear, act and plead
on my behalf in the above-noted matter, and authorise the said Advocate to file and receive
documents and pleadings, to deposit and withdraw money and grant valid receipts, and to do all
lawful acts necessary for the conduct of the case. I agree to ratify all such lawful acts.

Place: {{place}}                                  {{party_name}} (Executant)
Date: {{date}}                                    Accepted: {{advocate_name}}, Advocate`,
  },

  legal_notice: {
    label: 'Legal Notice',
    blanks: [
      { id: 'advocate_name', label: 'Advocate name', hint: '' },
      { id: 'advocate_address', label: 'Advocate address', hint: '' },
      { id: 'notice_date', label: 'Date of notice', hint: '' },
      { id: 'recipient_name', label: 'Recipient name', hint: '' },
      { id: 'recipient_address', label: 'Recipient address', hint: '' },
      { id: 'client_name', label: 'Client name', hint: '' },
      { id: 'subject', label: 'Subject', hint: 'one line' },
      { id: 'facts', label: 'Facts / grievance', hint: 'what happened' },
      { id: 'demand', label: 'Demand', hint: 'what the recipient must do' },
      { id: 'compliance_days', label: 'Days to comply', hint: 'e.g. 15' },
    ],
    template:
`LEGAL NOTICE
{{advocate_name}}, Advocate — {{advocate_address}}
Dated: {{notice_date}}

To,
{{recipient_name}}, {{recipient_address}}

Sub: {{subject}}

Under instructions from and on behalf of my client, {{client_name}}, I hereby serve upon you the following notice:
1. That {{facts}}.
2. That despite demand you have failed to comply, causing loss to my client.
3. You are called upon to {{demand}} within {{compliance_days}} days of receipt of this notice, failing
   which my client shall be constrained to initiate appropriate legal proceedings at your risk as to costs.

(({{advocate_name}}) — Advocate, for the client)`,
  },

  affidavit: {
    label: 'Affidavit',
    blanks: [
      { id: 'authority', label: 'Sworn before', hint: 'e.g. Notary Public, ____' },
      { id: 'deponent_name', label: 'Deponent name', hint: '' },
      { id: 'deponent_parentage', label: 'Parentage', hint: 'S/o, D/o, W/o ____' },
      { id: 'deponent_age', label: 'Age', hint: '' },
      { id: 'deponent_address', label: 'Address', hint: '' },
      { id: 'statements', label: 'Statement(s) of fact', hint: 'what you are declaring' },
      { id: 'purpose', label: 'Purpose', hint: 'why this affidavit is made' },
      { id: 'place', label: 'Place', hint: '' },
      { id: 'date', label: 'Date', hint: '' },
    ],
    template:
`AFFIDAVIT
Sworn before {{authority}}

I, {{deponent_name}}, {{deponent_parentage}}, aged about {{deponent_age}} years, R/o {{deponent_address}},
do hereby solemnly affirm and declare on oath as under:
1. That {{statements}}.
2. That this affidavit is made for the purpose of {{purpose}}.

VERIFICATION: Verified at {{place}} on {{date}} that the contents of this affidavit are true and correct
to my knowledge, and nothing material has been concealed therefrom.

{{deponent_name}} — Deponent`,
  },
};

// Cost/abuse guard on the assembled draft sent for scoring — contract caps
// this at ~3,500 tokens (~14,000 chars). Anything longer is rejected before
// enqueue/billing, never silently truncated.
const MAX_DRAFT_CHARS = 14000;

const assembleDraft = (templateType, fields) => {
  const def = DRAFT_TYPES[templateType];
  if (!def) return '';
  let out = def.template;
  for (const b of def.blanks) {
    const value = String(fields?.[b.id] ?? '').trim();
    out = out.split(`{{${b.id}}}`).join(value || `[${b.label}]`);
  }
  return out;
};

// Left as plain pool.query: ai_usage_log has no RLS policy (fire-and-forget
// analytics write, not one of the 5 RLS-protected tables).
const logUsage = (user_id, college_id, model, tin, tout) =>
  pool.query(
    `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
     VALUES ($1,$2,'drafting_lab',$3,$4,$5)`,
    [user_id, college_id, model, tin, tout]
  ).catch((e) => console.error('ai_usage_log insert failed:', e.message));

// sessions is RLS-protected — college_id is always req.user.college_id.
const loadOwnSession = async (id, user_id, college_id) => {
  const { rows } = await queryAsCollege(
    college_id,
    `SELECT * FROM sessions WHERE session_id=$1 AND user_id=$2 AND college_id=$3 AND feature_name='drafting_lab'`,
    [id, user_id, college_id]
  );
  return rows[0] || null;
};

// Presigns a GET url for a library PDF if the key is set — 10 minute expiry
// (long enough to view/download, short enough not to be a permanent public
// link). Returns null (not an error) if no key is stored yet, e.g. before
// backend/scripts/seedDraftLibraryPdfs.js has been run against a bucket.
const presignGet = (key) => {
  if (!key || !BUCKET) return null;
  try {
    return s3.getSignedUrl('getObject', { Bucket: BUCKET, Key: key, Expires: 600 });
  } catch {
    return null;
  }
};

// ── 1. Step 1 — View & Learn (no AI, unlimited, $0) ──────────────────────────
const getLibrary = (_req, res) => {
  const withUrls = draftLibrary.map((entry) => ({
    template_type: entry.template_type,
    label: entry.label,
    anatomy: entry.anatomy,
    specimens: Object.fromEntries(
      Object.entries(entry.specimens).map(([state, s]) => [
        state,
        {
          confidence: s.confidence,
          text: s.text,
          sourceUrl: s.sourceUrl,
          sourceLabel: s.sourceLabel,
          note: s.note || null,
          pdfUrl: presignGet(s.sourcePdfS3Key),
          scannedOfficialPdfUrl: presignGet(s.scannedOfficialPdfS3Key),
          supportingPdfUrl: presignGet(s.supportingPdfS3Key),
        },
      ])
    ),
  }));
  res.json({ library: withUrls });
};

// ── 2. Step 2 options — draft type picker ────────────────────────────────────
const getOptions = (_req, res) => {
  res.json({ types: Object.keys(DRAFT_TYPES).map((id) => ({ id, label: DRAFT_TYPES[id].label })) });
};

const safeParseJson = (text) => {
  if (!text) return null;
  let str = String(text).trim();
  str = str.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const sObj = str.indexOf('{'), sArr = str.indexOf('[');
  let start = -1, end = -1;
  if (sObj !== -1 && (sArr === -1 || sObj < sArr)) {
    start = sObj; end = str.lastIndexOf('}');
  } else if (sArr !== -1) {
    start = sArr; end = str.lastIndexOf(']');
  }

  if (start === -1 || end === -1 || end <= start) return null;
  const snippet = str.slice(start, end + 1);

  try {
    return JSON.parse(snippet);
  } catch (e1) {
    try {
      const fixed = snippet.replace(/[\r\n\t]/g, (m) => (m === '\n' ? '\\n' : m === '\r' ? '\\r' : '\\t'));
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
};

const generateCaseStudyDirectly = async (sessionId, template_type, label, user_id, college_id) => {
  try {
    const prompt = `You are a senior Indian advocate guiding a junior lawyer.
Generate a realistic factual scenario for drafting a ${label}.

Return ONLY valid JSON with no markdown fences:
{
  "title": "Title of the case study",
  "facts": "Detailed factual background of the dispute (2-3 paragraphs) giving all facts needed to fill out a ${label}.",
  "task": "Specific instructions for the student advocate."
}`;

    const { text, tokensIn, tokensOut } = await generateText({
      prompt,
      maxOutputTokens: 800,
      temperature: 0.3,
    });

    const parsed = safeParseJson(text) || {};

    const filters = {
      template_type,
      title: parsed.title || `${label} Case Study`,
      facts: parsed.facts || text || `Factual scenario prepared for drafting a ${label}. Fill out all compulsory fields accurately.`,
      task: parsed.task || `Draft a complete ${label} based on the above facts.`,
    };

    await pool.query(
      `UPDATE sessions SET status = 'active', filters = $1 WHERE session_id = $2`,
      [JSON.stringify(filters), sessionId]
    );

    pool.query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1,$2,'drafting_lab',$3,$4,$5)`,
      [user_id, college_id, process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', tokensIn, tokensOut]
    ).catch(() => {});

    return filters;
  } catch (err) {
    console.error('[draftingLab] Direct case study gen error:', err.message);
    const fallbackFilters = {
      template_type,
      title: `${label} Practice Case Study`,
      facts: `FACTUAL SCENARIO FOR ${label.toUpperCase()}:\n\n1. The deponent/applicant is a resident of Maharashtra and seeks formal legal drafting for court submission.\n2. All relevant particulars including date, place, names of parties, and relief claimed must be inserted into the specified placeholders.\n3. Review relevant procedural rules under Indian Law before finalizing the draft.`,
      task: `Complete the ${label} draft using the provided form fields.`,
    };

    await pool.query(
      `UPDATE sessions SET status = 'active', filters = $1 WHERE session_id = $2`,
      [JSON.stringify(fallbackFilters), sessionId]
    ).catch(() => {});
    return fallbackFilters;
  }
};

// ── 3. start a case study (AI call #1, 3/day via routes) ─────────────────────
const startCaseStudy = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const cid = college_id || null;
    const template_type = String(req.body.template_type || '');
    if (!DRAFT_TYPES[template_type]) {
      return res.status(400).json({ error: 'Please choose a valid draft type.' });
    }

    // college_id from req.user — RLS-scoped insert into sessions.
    const { rows } = await queryAsCollege(
      cid,
      `INSERT INTO sessions (user_id, college_id, feature_name, session_type, filters, status)
       VALUES ($1,$2,'drafting_lab','case_study',$3,'preparing') RETURNING session_id`,
      [user_id, cid, JSON.stringify({ template_type })]
    );
    const sessionId = rows[0].session_id;

    // Fast direct case study generation
    const finalFilters = await generateCaseStudyDirectly(sessionId, template_type, DRAFT_TYPES[template_type].label, user_id, cid);

    res.status(200).json({
      docId: sessionId,
      status: 'active',
      template_type,
      title: finalFilters.title,
      facts: finalFilters.facts,
      task: finalFilters.task
    });
  } catch (err) { next(err); }
};

// ── 4. poll case result — case facts + fields to fill ────────────────────────
const getCaseResult = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.docId, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Not found.' });

    if (s.status === 'preparing') return res.json({ status: 'preparing' });
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not generate a case. Please try again.' });

    const template_type = s.filters?.template_type;
    const def = DRAFT_TYPES[template_type] || {};
    return res.json({
      status: s.status, // active | scoring | complete
      docId: s.session_id,
      template_type,
      label: def.label,
      case: s.case_data?.case || null,
      fields: def.blanks || [],
      submission: s.submission || null,
      disclaimer: DISCLAIMER,
    });
  } catch (err) { next(err); }
};

// ── 5. submit filled fields → assemble draft → enqueue AI call #2 ───────────
const submitCaseStudy = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const doc_id = req.body.doc_id;
    const fields = req.body.fields && typeof req.body.fields === 'object' ? req.body.fields : {};

    const s = await loadOwnSession(doc_id, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Not found.' });
    if (s.status !== 'active') return res.status(409).json({ error: 'This exercise is not ready to submit.' });

    const template_type = s.filters?.template_type;
    const assembledDraft = assembleDraft(template_type, fields);

    if (assembledDraft.length > MAX_DRAFT_CHARS) {
      // Rejected BEFORE enqueue/billing — never silently truncated (contract).
      return res.status(400).json({ error: `Your draft is too long (max ~${MAX_DRAFT_CHARS} characters). Please shorten it.` });
    }
    if (!assembledDraft.trim()) {
      return res.status(400).json({ error: 'Please fill in at least some of the fields before submitting.' });
    }

    // college_id already ownership-verified above via loadOwnSession.
    await queryAsCollege(
      college_id,
      `UPDATE sessions SET submission=$2, status='scoring' WHERE session_id=$1`,
      [doc_id, JSON.stringify({ fields, assembledDraft })]
    );

    // Pass the student's raw field-by-field answers alongside the assembled
    // draft — the worker's scoring prompt needs to see which text is genuinely
    // the student's own input vs. fixed template boilerplate (every draft of
    // this type shares the same headings/clauses), so it never mistakenly
    // credits the student for wording they didn't write.
    const blanksSpec = (DRAFT_TYPES[template_type]?.blanks || []).map((b) => ({ id: b.id, label: b.label }));

    await draftQueue.add(
      'score-draft',
      { sessionId: doc_id, template_type, assembledDraft, fields, blanksSpec, user_id, college_id },
      { removeOnComplete: 100, removeOnFail: 100, attempts: 1 }
    );

    res.status(202).json({ docId: doc_id, status: 'scoring' });
  } catch (err) { next(err); }
};

// ── 6. poll score result ─────────────────────────────────────────────────────
const getScore = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    const s = await loadOwnSession(req.params.docId, user_id, college_id);
    if (!s) return res.status(404).json({ error: 'Not found.' });

    if (s.status === 'scoring') return res.json({ status: 'scoring' });
    if (s.status === 'failed') return res.json({ status: 'failed', message: 'Could not score your draft. Please try again.' });
    if (s.status !== 'complete' || !s.summary) return res.json({ status: s.status });

    res.json({ status: 'complete', result: JSON.parse(s.summary) });
  } catch (err) { next(err); }
};

// ── 7. history ────────────────────────────────────────────────────────────────
const getHistory = async (req, res, next) => {
  try {
    const { user_id, college_id } = req.user;
    // college_id from req.user — RLS-scoped read of sessions.
    const { rows } = await queryAsCollege(
      college_id,
      `SELECT session_id, status, filters->>'template_type' AS template_type, created_at
         FROM sessions
        WHERE user_id = $1 AND college_id = $2 AND feature_name = 'drafting_lab'
        ORDER BY created_at DESC LIMIT 50`,
      [user_id, college_id]
    );
    res.json({ history: rows.map((r) => ({ docId: r.session_id, status: r.status, templateType: r.template_type, created_at: r.created_at })) });
  } catch (err) { next(err); }
};

module.exports = {
  getLibrary, getOptions, startCaseStudy, getCaseResult, submitCaseStudy, getScore, getHistory,
  // exported for the worker to reuse (same source of truth for templates/blanks)
  DRAFT_TYPES, assembleDraft, logUsage,
};
