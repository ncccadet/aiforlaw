/**
 * resumeAnalyzer.worker.js — BullMQ worker
 * Contract: _contracts/02-resume-analyzer.md
 *
 * WHY A WORKER (P004): a malicious or corrupt PDF can crash the parser. Isolating
 * all PDF reading + the Gemini call here means the main API process stays alive.
 *
 * FLOW per job:
 *   1. Download the PDF from S3 (buffer only — never written to disk).
 *   2. Validate it: %PDF magic bytes → structure scan for embedded scripts/
 *      launch actions (see hasSuspiciousPdfSignals) → pdf-parse → 1–3 pages →
 *      has real text.
 *   3. Cheap résumé pre-filter (keyword signals) to reject obvious non-résumés
 *      before spending a Gemini call.
 *   4. Truncate text to ~3000 tokens, then ONE Gemini call via the shared
 *      gemini.service.js native REST client (maxOutputTokens 1500, JSON prompt).
 *   5. The model returns isResume + 7 scored parameters. If isResume is false,
 *      mark the document 'failed' with a friendly message.
 *   6. Render a downloadable PDF report of the analysis (pdfkit, styled to match
 *      this feature's own dark theme — see renderReportPdf) and upload it to S3.
 *   7. UPDATE documents (status + analysis_json, including the report's S3 key),
 *      scoped by doc_id.
 *   8. Log tokens to ai_usage_log (source of truth for the cost review).
 *
 * Every failure path marks the document 'failed' so the student stops polling.
 * There is no Redis refund step: this feature has no daily limit to refund.
 *
 * 2026-07-22 adaptation notes (see decisions-log for the full rationale):
 *   - Rewired the Gemini call from the founder-provided zip's `@google/generative-ai`
 *     SDK to the shared `gemini.service.js` native REST client — same reason as
 *     every other AI feature here: avoids the SDK-shim class of `AQ.`-prefixed-key
 *     auth failures. Also corrected the model id (the zip had a typo,
 *     `gemini-3-1-flash-lite`, which doesn't match any real Gemini model —
 *     the actual, verified-working id is `gemini-3.1-flash-lite`, same as the
 *     project's other Gemini calls).
 *   - Added hasSuspiciousPdfSignals: a lightweight structural check (no ClamAV/
 *     antivirus daemon — founder decision, given t3.micro/t3.small headroom)
 *     that rejects PDFs carrying embedded JavaScript, launch actions, or
 *     embedded files before they're ever parsed or sent to Gemini.
 *   - Added renderReportPdf + the S3 upload of that report (founder request:
 *     downloadable PDF of the analysis, styled like the on-screen results).
 *   - Swapped `pdf-parse` (the zip's original choice) for `pdfjs-dist` (Mozilla's
 *     actively-maintained pdf.js, used directly). Testing found `pdf-parse`'s
 *     bundled pdf.js build (v1.10.100, from ~2017) throws "bad XRef entry" on
 *     otherwise completely standard, valid PDFs — verified with `pdfinfo`/
 *     `pdftotext` (poppler) that the test files were valid; `pdf-parse` itself
 *     was the broken part, not the fixture. Since this is the step that decides
 *     whether every real student's uploaded résumé is even readable, shipping
 *     it as-is would have meant an unpredictable slice of genuine PDF résumés
 *     failing with "could not read this PDF" for no real reason. `pdfjs-dist`
 *     parsed every test file correctly, including the ones that broke
 *     `pdf-parse`, so it replaces `pdf-parse` as the extraction library —
 *     same job (page count + text), no behavior change to the rest of the
 *     pipeline or the contract.
 */
// Loads .env into process.env — required because this worker runs as its own
// standalone pm2 process (`pm2 start resumeAnalyzer.worker.js`), not through
// app.js, so nothing else guarantees .env has been read. Without this, every
// env-derived value below (DATABASE_URL, S3_BUCKET_FILES, GEMINI_API_KEY, ...)
// is silently undefined — found on staging as a generic "We could not find
// your uploaded file" error, because s3.getObject({ Bucket: undefined, ... })
// fails without a clear message. Matches the pattern otp.worker.js already
// uses for the same reason.
require('dotenv').config();
const { Worker } = require('bullmq');
const AWS = require('aws-sdk');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const { generateText } = require('../services/gemini.service');

// pdfjs-dist looks for its bundled standard fonts (used as a fallback when a
// PDF doesn't embed its own font) at this path. Without it, extraction still
// works — it just logs a non-fatal warning per document. Pointing it at the
// real on-disk location silences that noise in the worker's logs.
const STANDARD_FONT_DATA_URL = `file://${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

/**
 * Extracts page count + all text from a PDF buffer using pdfjs-dist directly
 * (no pdf-parse wrapper — see the adaptation note above for why).
 * Returns { numpages, text }. Throws on a corrupt/unreadable PDF, same
 * contract as pdf-parse had, so the caller's existing try/catch still works.
 */
const extractPdfText = async (buffer) => {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0, // errors only — suppress the routine font-fallback warning
    isEvalSupported: false, // no reason a résumé PDF needs to eval anything
  }).promise;

  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return { numpages: doc.numPages, text };
};

// max: 5 — pool cap, see controllers/aiInterviewer.controller.js for the full
// reasoning (2026-07-25 connection-pool sizing pass, decisions-log.md).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const s3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: 'v4', sslEnabled: true });
const BUCKET = process.env.S3_BUCKET_FILES;

// Matches gemini.service.js's DEFAULT_MODEL and the project contract — never
// hardcode a different model id here (see the 2026-07-22 note above about the
// zip's typo'd model id).
const MODEL_ID = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const DISCLAIMER = 'For educational purposes only. Verify with a qualified advocate.';

// ── Token / size caps (contract) ─────────────────────────────────────────────
const MAX_INPUT_CHARS  = 12000; // ~3000 tokens of PDF text (≈4 chars/token)
const MAX_OUTPUT_TOKENS = 1500;
const MIN_TEXT_CHARS   = 150;   // below this = image-only/scanned/empty PDF
const MIN_PAGES = 1;
const MAX_PAGES = 3;

// The exact 7 parameters the model must score (contract). Order is enforced.
const PARAMETERS = [
  'Structure & Formatting',
  'Contact & Online Presence',
  'Education & Academic Record',
  'Legal Experience & Internships',
  'Skills & Competencies',
  'Achievements & Impact',
  'Language, Grammar & Clarity',
];

// Cheap résumé signal words — used only as a pre-filter, not the final verdict.
const RESUME_SIGNALS = [
  'experience', 'education', 'skills', 'internship', 'project', 'objective',
  'curriculum vitae', 'resume', 'résumé', 'university', 'college', 'bachelor',
  'llb', 'ba llb', 'moot', 'certification', 'achievement', 'reference',
  'email', 'phone', 'linkedin', 'languages',
];

// ── Sanitization: lightweight PDF-structure malware check ────────────────────
// Founder decision (2026-07-22): a real antivirus scan (ClamAV) needs a daemon
// installed and running on the EC2 box — real memory/CPU overhead we don't
// want on a t3.micro/t3.small. Instead, scan the raw PDF bytes for the
// structural markers that matter for a résumé upload: embedded JavaScript,
// launch actions (run an external program), and embedded files — the
// realistic threat model for "student uploads a booby-trapped PDF", not
// generic malware signatures. A legitimate résumé PDF never needs any of these.
const SUSPICIOUS_PDF_SIGNALS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia'];

const hasSuspiciousPdfSignals = (buffer) => {
  // PDF names/dictionary keys are always plain ASCII in the file's object
  // structure (even when content streams are compressed), so a latin1 scan of
  // the raw bytes reliably finds these tokens without needing to parse the
  // PDF's object graph.
  const raw = buffer.toString('latin1');
  return SUSPICIOUS_PDF_SIGNALS.some((sig) => raw.includes(sig));
};

const buildPrompt = (resumeText) => `You are an expert legal-careers résumé reviewer for Indian law students.
Analyse the résumé text between the <resume> tags.

First decide whether the document actually is a résumé / CV (not an invoice, letter,
notes, article, or any other document). If it is NOT a résumé, respond with EXACTLY:
{"isResume": false, "reason": "<short reason>"}

If it IS a résumé, score it on these SEVEN parameters, in this exact order:
${PARAMETERS.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Respond with STRICT JSON only (no markdown, no prose) in this shape:
{
  "isResume": true,
  "overallScore": <integer 0-100>,
  "summary": "<one or two sentence overall impression>",
  "parameters": [
    { "name": "<one of the 7 names, exact>", "score": <integer 0-100>,
      "strengths": ["<short point>", "..."],
      "improvements": ["<specific, actionable point>", "..."] }
  ]
}
Rules: exactly 7 objects in "parameters", names exactly as listed and in order.
1-3 bullet points per list. Be specific and constructive. Do not invent facts that
are not in the résumé. Keep the whole response under ${MAX_OUTPUT_TOKENS} tokens.

<resume>
${resumeText}
</resume>`;

// ── DB helpers (always scoped by doc_id — a job can only touch its own row) ───
const markFailed = (docId, message) =>
  pool.query(
    `UPDATE documents SET status = 'failed', analysis_json = $2 WHERE doc_id = $1`,
    [docId, JSON.stringify({ message })]
  );

const markComplete = (docId, analysis) =>
  pool.query(
    `UPDATE documents SET status = 'complete', analysis_json = $2 WHERE doc_id = $1`,
    [docId, JSON.stringify(analysis)]
  );

const logUsage = (user_id, college_id, tokensIn, tokensOut) =>
  pool
    .query(
      `INSERT INTO ai_usage_log (user_id, college_id, feature_name, model, tokens_in, tokens_out)
       VALUES ($1, $2, 'resume_analyzer', $3, $4, $5)`,
      [user_id, college_id, MODEL_ID, tokensIn, tokensOut]
    )
    .catch((e) => console.error('ai_usage_log insert failed:', e.message)); // never fail the job over logging

// Pull the first {...} block out of the model text and parse it. Tolerant of
// stray markdown fences the model occasionally adds.
const parseModelJson = (text) => {
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
};

// Validate + normalise the model's résumé analysis into exactly our 7-parameter shape.
const normaliseAnalysis = (parsed) => {
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  if (!Array.isArray(parsed.parameters)) throw new Error('missing parameters array');

  const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const asList = (v) =>
    (Array.isArray(v) ? v : [v]).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 3);

  // Map by (case-insensitive) name so order/casing wobble in the model doesn't break us.
  const byName = new Map(
    parsed.parameters
      .filter((p) => p && p.name)
      .map((p) => [String(p.name).toLowerCase().trim(), p])
  );

  const parameters = PARAMETERS.map((name) => {
    const p = byName.get(name.toLowerCase()) || {};
    return {
      name,
      score: clampScore(p.score),
      strengths: asList(p.strengths),
      improvements: asList(p.improvements),
    };
  });

  const overallScore =
    parsed.overallScore != null
      ? clampScore(parsed.overallScore)
      : Math.round(parameters.reduce((s, p) => s + p.score, 0) / parameters.length);

  return {
    overallScore,
    summary: String(parsed.summary || '').trim().slice(0, 500),
    parameters,
    disclaimer: DISCLAIMER,
  };
};

// One Gemini call via the shared native REST client. Returns { text, tokensIn, tokensOut }.
const callGemini = async (prompt) => {
  const { text, tokensIn, tokensOut } = await generateText({
    prompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  });
  return { text, tokensIn, tokensOut };
};

// ── Step 6: render a downloadable PDF report, styled to match the page's own
// dark theme (--bg:#0e0e0e, --surface:#1a1a1a, --border:#343434, --text:#ededed,
// --accent:#d8d8d8 — see ResumeAnalyzerPage.jsx's RA_STYLES). Serif body font
// (Times-Roman/Times-Bold, pdfkit's built-ins) to echo the page's Georgia/serif
// family without needing to embed a font file. ─────────────────────────────────
const RPT_BG = '#0e0e0e';
const RPT_SURFACE = '#1a1a1a';
const RPT_BORDER = '#3a3a3a';
const RPT_TEXT = '#ededed';
const RPT_MUTED = '#a0a0a0';
const RPT_ACCENT = '#e2e2e2';
const RPT_MARGIN = 46;

const paintPageBackground = (doc) => {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(RPT_BG);
};

const renderReportPdf = (analysis, studentName) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: RPT_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.on('pageAdded', () => paintPageBackground(doc));

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - RPT_MARGIN * 2;

    paintPageBackground(doc); // first page — 'pageAdded' doesn't fire for it

    // ── Header ──
    doc.fillColor(RPT_TEXT).font('Times-Bold').fontSize(24).text('Résumé Analysis Report', RPT_MARGIN, RPT_MARGIN);
    if (studentName) {
      doc.font('Times-Roman').fontSize(11).fillColor(RPT_MUTED).text(studentName, { width: contentWidth });
    }
    doc.moveDown(0.6);
    doc.strokeColor(RPT_BORDER).lineWidth(1).moveTo(RPT_MARGIN, doc.y).lineTo(pageWidth - RPT_MARGIN, doc.y).stroke();
    doc.moveDown(1);

    // ── Overall score ──
    // NOTE: a `continued: true` text() call followed by a differently-sized
    // font (46pt digits, then a 16pt "/100") only advances doc.y by the LAST
    // call's line height, not the tallest one on the line — left alone, the
    // next block (summary) would start high enough to overlap the big
    // digits' descenders. Fixed by explicitly placing doc.y below the full
    // 46pt line height instead of trusting the automatic cursor advance.
    const overallY = doc.y;
    doc.font('Times-Bold').fontSize(46).fillColor(RPT_ACCENT).text(String(analysis.overallScore), RPT_MARGIN, overallY, { continued: true });
    doc.font('Times-Roman').fontSize(16).fillColor(RPT_MUTED).text('/100');
    doc.y = overallY + 58; // clears the 46pt line (font size × ~1.25 line height) with margin
    if (analysis.summary) {
      doc.font('Times-Roman').fontSize(11.5).fillColor(RPT_TEXT).text(analysis.summary, RPT_MARGIN, doc.y, { width: contentWidth });
    }
    doc.moveDown(1.2);

    // ── Per-parameter cards ──
    analysis.parameters.forEach((p) => {
      // Keep a card together on one page where reasonably possible.
      const estimatedHeight = 34 + (p.strengths.length + p.improvements.length) * 16 + 20;
      if (doc.y + estimatedHeight > doc.page.height - RPT_MARGIN) {
        doc.addPage();
      }

      const cardTop = doc.y;
      doc.font('Times-Bold').fontSize(13).fillColor(RPT_TEXT).text(p.name, RPT_MARGIN, cardTop, { continued: true, width: contentWidth - 50 });
      doc.font('Times-Bold').fontSize(13).fillColor(RPT_ACCENT).text(`  ${p.score}`, { align: 'right' });

      // Score bar.
      const barY = doc.y + 4;
      const barW = contentWidth;
      doc.rect(RPT_MARGIN, barY, barW, 5).fill(RPT_SURFACE);
      doc.rect(RPT_MARGIN, barY, barW * Math.max(0, Math.min(100, p.score)) / 100, 5).fill(RPT_ACCENT);
      doc.y = barY + 14;

      if (p.strengths.length) {
        p.strengths.forEach((s) => {
          doc.font('Times-Roman').fontSize(10.5).fillColor(RPT_TEXT).text(`+  ${s}`, RPT_MARGIN, doc.y, { width: contentWidth });
        });
      }
      if (p.improvements.length) {
        p.improvements.forEach((s) => {
          // pdfkit's built-in Times-Italic only supports WinAnsi encoding — the
          // "→" glyph on-screen (RA_STYLES) doesn't exist in it and rendered as
          // a mangled placeholder in testing. Use a plain ASCII arrow instead.
          doc.font('Times-Italic').fontSize(10.5).fillColor(RPT_MUTED).text(`->  ${s}`, RPT_MARGIN, doc.y, { width: contentWidth });
        });
      }

      doc.moveDown(0.5);
      doc.strokeColor(RPT_BORDER).lineWidth(0.75).moveTo(RPT_MARGIN, doc.y).lineTo(pageWidth - RPT_MARGIN, doc.y).stroke();
      doc.moveDown(0.8);
    });

    // ── Footer disclaimer ──
    // Placed inline right after the last card. Two things learned from
    // testing a long, multi-page analysis: (1) a card's actual rendered
    // height can exceed the per-card estimate above when strengths/
    // improvements wrap onto a second line, so doc.y after the LAST card can
    // already be past the bottom margin — pdfkit doesn't clamp moveDown() to
    // the page bounds. (2) Calling .text() with an already-overflowed y
    // doesn't reliably auto-paginate the way a mid-flow overflow does; it can
    // silently place the text off the visible page. So: measure the
    // disclaimer's real height and explicitly addPage() only if what's left
    // on the current page genuinely isn't enough — never pinned to an
    // absolute bottom-of-page position (that wasted an entire page on one
    // line whenever a page break wasn't actually needed).
    const disclaimerText = analysis.disclaimer || DISCLAIMER;
    doc.font('Times-Italic').fontSize(9.5);
    const disclaimerHeight = doc.heightOfString(disclaimerText, { width: contentWidth });
    if (doc.y + disclaimerHeight > doc.page.height - RPT_MARGIN) {
      doc.addPage();
    }
    doc.fillColor(RPT_MUTED).text(disclaimerText, RPT_MARGIN, doc.y, {
      width: contentWidth,
      align: 'center',
    });

    doc.end();
  });

// ── The job processor ────────────────────────────────────────────────────────
const processJob = async (job) => {
  const { docId, s3Key, user_id, college_id } = job.data;

  // 1. Download PDF as a buffer (never touches disk).
  let buffer;
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: s3Key }).promise();
    buffer = obj.Body;
  } catch (e) {
    await markFailed(docId, 'We could not find your uploaded file. Please try uploading again.');
    return;
  }

  // 2a. Magic bytes — a .jpg/.exe renamed .pdf is rejected here.
  if (!buffer || buffer.length < 5 || buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    await markFailed(docId, 'That file is not a valid PDF. Please upload a PDF résumé.');
    return;
  }

  // 2b. Sanitization — reject PDFs carrying embedded scripts/launch actions/
  // embedded files before we ever parse or send them anywhere further.
  if (hasSuspiciousPdfSignals(buffer)) {
    await markFailed(docId, 'This PDF contains embedded scripts or actions that are not allowed. Please upload a plain résumé PDF.');
    return;
  }

  // 2c. Parse: text + page count.
  let parsedPdf;
  try {
    parsedPdf = await extractPdfText(buffer);
  } catch (e) {
    await markFailed(docId, 'We could not read this PDF. Please upload a text-based (not scanned) PDF résumé.');
    return;
  }

  const numPages = parsedPdf.numpages || 0;
  const text = (parsedPdf.text || '').replace(/\s+\n/g, '\n').trim();

  if (numPages < MIN_PAGES || numPages > MAX_PAGES) {
    await markFailed(
      docId,
      `A résumé should be ${MIN_PAGES}–${MAX_PAGES} pages. This PDF has ${numPages} page(s). Please upload a shorter résumé.`
    );
    return;
  }
  if (text.length < MIN_TEXT_CHARS) {
    await markFailed(docId, 'We could not extract text from this PDF (it may be a scanned image). Please upload a text-based PDF résumé.');
    return;
  }

  // 3. Cheap résumé pre-filter — reject obvious non-résumés without spending a call.
  const lower = text.toLowerCase();
  const signalHits = RESUME_SIGNALS.filter((w) => lower.includes(w)).length;
  if (signalHits < 2) {
    await markFailed(docId, 'This does not look like a résumé. Please upload your CV / résumé as a PDF.');
    return;
  }

  // 4. Truncate to the input token cap, then call Gemini (one retry on bad JSON).
  const resumeText = text.slice(0, MAX_INPUT_CHARS);
  const prompt = buildPrompt(resumeText);

  let parsed;
  let totalIn = 0;
  let totalOut = 0;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text: out, tokensIn, tokensOut } = await callGemini(prompt);
      totalIn += tokensIn;
      totalOut += tokensOut;
      parsed = parseModelJson(out);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  // Log whatever tokens we actually spent, even on failure (cost is cost).
  if (totalIn || totalOut) logUsage(user_id, college_id, totalIn, totalOut);

  if (!parsed) {
    await markFailed(docId, 'Our analyser had trouble reading this résumé. Please try again in a moment.');
    throw lastErr || new Error('resume analysis: unparseable model output'); // surfaces in logs
  }

  // 5. Model's résumé verdict.
  if (parsed.isResume === false) {
    await markFailed(docId, 'This does not look like a résumé. Please upload your CV / résumé as a PDF.');
    return;
  }

  // 6. Normalise to our fixed 7-parameter shape, render the downloadable report,
  // upload it to S3, then store both in one UPDATE.
  const analysis = normaliseAnalysis(parsed);

  let reportS3Key = null;
  try {
    const reportBuffer = await renderReportPdf(analysis);
    reportS3Key = `resume-analyses/${college_id}/${user_id}/${docId}.pdf`;
    await s3.upload({
      Bucket: BUCKET,
      Key: reportS3Key,
      Body: reportBuffer,
      ContentType: 'application/pdf',
    }).promise();
  } catch (e) {
    // Report generation is a nice-to-have on top of the already-scored analysis —
    // never fail the whole analysis over a PDF-rendering hiccup. The student
    // still gets their scored feedback; just no downloadable PDF this time.
    console.error(`[resume_analyzer] report PDF generation/upload failed for doc ${docId}:`, e.message);
    reportS3Key = null;
  }

  await markComplete(docId, { ...analysis, reportS3Key });
};

const worker = new Worker('resume-analysis', processJob, {
  connection: require('../config/redisConnection'),
});

worker.on('completed', (job) => console.log(`Resume job ${job.id} done (doc ${job.data.docId})`));
worker.on('failed', (job, err) => console.error(`Resume job ${job?.id} failed:`, err?.message));

module.exports = worker;
module.exports.renderReportPdf = renderReportPdf; // exported for testing
module.exports.normaliseAnalysis = normaliseAnalysis; // exported for testing
module.exports.hasSuspiciousPdfSignals = hasSuspiciousPdfSignals; // exported for testing
module.exports.extractPdfText = extractPdfText; // exported for testing
module.exports.processJob = processJob; // exported for testing
