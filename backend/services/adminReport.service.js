/**
 * adminReport.service.js — renders the daily and monthly PDF reports.
 *
 * Uses pdfkit, which is ALREADY a backend dependency (Resume Builder and
 * Resume Analyzer both render PDFs with it) — no new package was added for
 * this feature.
 *
 * DESIGN BRIEF, in the founder's words: "as we download something from
 * Claude, it's very simple, it's neat and clean. Same way I want that report
 * too." So: white page, black text, one hairline rule under each section
 * heading, generous margins, no colour blocks, no charts, no logos. Times for
 * headings (matches the app's serif), Helvetica for figures and tables so
 * numbers line up and read cleanly at small sizes.
 *
 * ── ONE NON-OBVIOUS THING, READ BEFORE "FIXING" IT ────────────────────────
 * Money is printed as "Rs. 1,234.56", never with the rupee glyph. pdfkit's
 * built-in fonts (Helvetica, Times) are WinAnsi-encoded, and the Indian rupee
 * sign U+20B9 does not exist in WinAnsi — pdfkit silently substitutes a
 * different glyph, so a report would show a wrong or missing symbol next to
 * every cost figure. Printing the rupee sign properly would mean shipping and
 * embedding a Unicode TTF, which is a real cost (file, license, ~300KB in the
 * repo) for a cosmetic gain on a report only the founder reads. "Rs." is
 * deliberate, not an oversight.
 */
const PDFDocument = require('pdfkit');
const { labelFor } = require('./adminStats.service');

const MARGIN = 56;               // ~20mm — generous, matches the "neat and clean" brief
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';

const H_FONT = 'Times-Bold';
const H_ITALIC = 'Times-Italic';
const B_FONT = 'Helvetica';
const B_BOLD = 'Helvetica-Bold';

/** 1234567.8 -> "12,34,567.80" (Indian digit grouping — the audience is Indian). */
function inr(n) {
  const v = Number(n || 0);
  return `Rs. ${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** Plain integer with Indian grouping. */
function num(n) {
  return Number(n || 0).toLocaleString('en-IN');
}
/** '2026-07-27' -> '27 July 2026'. Never relies on the server's locale. */
function prettyDate(iso) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
/** '2026-07' -> 'July 2026'. */
function prettyMonth(iso) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m] = String(iso).split('-');
  return `${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
/** Current time in IST, for the "generated at" line. Server runs on UTC. */
function nowIst() {
  const d = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} IST`;
}

// ── Layout primitives ──────────────────────────────────────────────────────

function contentWidth(doc) {
  return doc.page.width - MARGIN * 2;
}

/**
 * Start a new page if fewer than `needed` points remain, so a section heading
 * never ends up orphaned at the foot of a page with its table on the next.
 */
function ensureSpace(doc, needed) {
  const bottom = doc.page.height - MARGIN - 24; // 24pt reserved for the footer
  if (doc.y + needed > bottom) doc.addPage();
}

function sectionHeading(doc, text) {
  // 90pt ≈ the heading (with its rule and leading) plus a table header row plus
  // one data row. 60 was not enough: in the monthly report "Day by day" printed
  // at the foot of page 1 with its entire table on page 2, which reads like the
  // section is empty. Caught by looking at the rendered pages, not by a test.
  ensureSpace(doc, 90);
  doc.moveDown(1);
  doc.font(H_FONT).fontSize(13).fillColor(INK).text(text, MARGIN, doc.y);
  const y = doc.y + 3;
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y)
     .lineWidth(0.75).strokeColor(RULE).stroke();
  doc.y = y + 10;
}

/** A "Label ....... value" line — the summary block. */
function keyValue(doc, label, value) {
  ensureSpace(doc, 20);
  const y = doc.y;
  doc.font(B_FONT).fontSize(10).fillColor(MUTED).text(label, MARGIN, y, { width: contentWidth(doc) * 0.6 });
  doc.font(B_BOLD).fontSize(10).fillColor(INK)
     .text(value, MARGIN, y, { width: contentWidth(doc), align: 'right' });
  doc.y = y + 16;
}

/**
 * A simple table. `columns` is [{ header, width (fraction of content width),
 * align }], `rows` is an array of arrays of pre-formatted strings.
 * Rows are drawn one at a time with a page-break check before each, so a long
 * table (a month of daily figures, 100 headlines) flows onto extra pages
 * correctly instead of running off the bottom.
 */
function table(doc, columns, rows, { emptyText = 'No activity recorded.' } = {}) {
  const W = contentWidth(doc);
  const widths = columns.map((c) => c.width * W);
  // Left edge of each column = MARGIN + the sum of every width before it.
  // Written as a plain running total on purpose: the previous one-liner reduce
  // here was off by one (it seeded the accumulator with MARGIN and then also
  // pushed MARGIN for i=0), so column 1 was drawn at column 0's x and every
  // cell after it sat one slot to the left — "Court Simulation" and its call
  // count printed on top of each other. Caught by rendering the PDF to an
  // image and looking at it, not by any assertion.
  const xs = [];
  let cursor = MARGIN;
  for (const w of widths) { xs.push(cursor); cursor += w; }

  if (rows.length === 0) {
    doc.font(H_ITALIC).fontSize(10).fillColor(MUTED).text(emptyText, MARGIN, doc.y);
    doc.y += 6;
    return;
  }

  const drawHeader = () => {
    const y = doc.y;
    doc.font(B_BOLD).fontSize(9).fillColor(MUTED);
    columns.forEach((c, i) => {
      doc.text(c.header, xs[i], y, { width: widths[i], align: c.align || 'left' });
    });
    const ry = y + 12;
    doc.moveTo(MARGIN, ry).lineTo(doc.page.width - MARGIN, ry)
       .lineWidth(0.5).strokeColor(RULE).stroke();
    doc.y = ry + 6;
  };

  ensureSpace(doc, 46);
  drawHeader();

  for (const row of rows) {
    // Measure the tallest cell first — a long job title wraps to two lines and
    // the row must grow with it, or the next row overlaps it.
    doc.font(B_FONT).fontSize(9.5);
    const heights = row.map((cell, i) =>
      doc.heightOfString(String(cell ?? ''), { width: widths[i] - 6 })
    );
    const rowHeight = Math.max(...heights, 12) + 6;

    if (doc.y + rowHeight > doc.page.height - MARGIN - 24) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    doc.font(B_FONT).fontSize(9.5).fillColor(INK);
    row.forEach((cell, i) => {
      doc.text(String(cell ?? ''), xs[i], y, {
        width: widths[i] - 6,
        align: columns[i].align || 'left',
      });
    });
    doc.y = y + rowHeight;
  }
  doc.y += 4;
}

/** Title block at the top of page 1. */
function titleBlock(doc, title, subtitle) {
  doc.font(H_FONT).fontSize(20).fillColor(INK).text('Voxera For Law', MARGIN, MARGIN);
  doc.font(B_FONT).fontSize(11).fillColor(MUTED).text(title, MARGIN, doc.y + 2);
  doc.font(B_FONT).fontSize(9).fillColor(MUTED).text(subtitle, MARGIN, doc.y + 2);
  const y = doc.y + 8;
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y)
     .lineWidth(1).strokeColor(INK).stroke();
  doc.y = y + 14;
}

/**
 * Page numbers, written after all content exists.
 * bufferPages: true is what makes this possible — without it pdfkit flushes
 * each page as it is finished and earlier pages can no longer be edited.
 */
function paginate(doc, footerNote) {
  const range = doc.bufferedPageRange();
  // Count the pages ONCE, before writing anything. Re-reading
  // bufferedPageRange().count inside the loop would be a moving target if a
  // write ever appended a page, and "Page 1 of 6" on a 2-page report is
  // exactly the kind of wrong that goes unnoticed.
  const total = range.count;

  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);

    // The footer sits in the bottom margin, BELOW doc.page.maxY(). pdfkit
    // treats any text starting past maxY as an overflow and silently calls
    // addPage() — which, during pagination, appended a fresh blank page for
    // every footer written. A 2-page report came out as 6 pages, 4 of them
    // empty. Dropping the bottom margin to 0 for the duration of the write
    // makes the footer legal where it is; it is restored immediately after.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - MARGIN + 8;
    doc.font(B_FONT).fontSize(8).fillColor(MUTED)
       .text(footerNote, MARGIN, y, { width: contentWidth(doc) * 0.7, lineBreak: false })
       .text(`Page ${i - range.start + 1} of ${total}`, MARGIN, y,
             { width: contentWidth(doc), align: 'right', lineBreak: false });

    doc.page.margins.bottom = savedBottom;
  }
  doc.flushPages();
}

// ── Daily report ───────────────────────────────────────────────────────────

/**
 * @param {object} metrics - a daily_stats.metrics object (stored or live)
 * @param {{ live?: boolean }} opts - live=true stamps "figures as at <time>",
 *   because a report pulled at 2pm is not the finished day.
 * @returns {PDFDocument} a streamable document (already ended)
 */
function buildDailyPdf(metrics, { live = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });

  titleBlock(
    doc,
    `Daily Report — ${prettyDate(metrics.date)}`,
    live
      ? `Day still in progress. Figures as at ${nowIst()}.`
      : `Generated ${nowIst()} from the snapshot taken at end of day.`
  );

  // ── Summary ──
  sectionHeading(doc, 'Summary');
  keyValue(doc, 'AI cost for the day',            inr(metrics.tokens?.costInr));
  keyValue(doc, 'AI calls',                       num(metrics.tokens?.calls));
  keyValue(doc, 'Tokens in / out',                `${num(metrics.tokens?.totalIn)}  /  ${num(metrics.tokens?.totalOut)}`);
  keyValue(doc, 'Students active today',          num(metrics.students?.activeToday));
  keyValue(doc, 'Students on the platform',       num(metrics.students?.total));
  keyValue(doc, 'Job applications clicked',       num(metrics.jobs?.applyClicks));
  keyValue(doc, 'Errors logged',                  num(metrics.errors?.total));

  // ── Tokens by feature ──
  sectionHeading(doc, 'AI usage by feature');
  table(doc,
    [
      { header: 'Feature',    width: 0.34 },
      { header: 'Calls',      width: 0.14, align: 'right' },
      { header: 'Tokens in',  width: 0.17, align: 'right' },
      { header: 'Tokens out', width: 0.17, align: 'right' },
      { header: 'Cost',       width: 0.18, align: 'right' },
    ],
    (metrics.tokens?.byFeature || []).map((f) => [
      f.label || labelFor(f.feature), num(f.calls), num(f.tokensIn), num(f.tokensOut), inr(f.costInr),
    ]),
    { emptyText: 'No AI calls were made today.' }
  );

  // ── Feature usage ──
  sectionHeading(doc, 'Feature usage');
  table(doc,
    [
      { header: 'Feature', width: 0.7 },
      { header: 'Times used', width: 0.3, align: 'right' },
    ],
    (metrics.features || []).map((f) => [f.label, num(f.count)]),
    { emptyText: 'No feature activity recorded today.' }
  );

  // ── Jobs ──
  sectionHeading(doc, 'Job Board');
  keyValue(doc, 'New listings added today', num(metrics.jobs?.newToday));
  keyValue(doc, 'Listings live at snapshot time', num(metrics.jobs?.totalActive));
  keyValue(doc, 'Apply clicks', num(metrics.jobs?.applyClicks));
  keyValue(doc, 'Distinct students who clicked', num(metrics.jobs?.uniqueClickers));
  if ((metrics.jobs?.topClicked || []).length > 0) {
    doc.moveDown(0.4);
    table(doc,
      [
        { header: 'Most clicked listings', width: 0.55 },
        { header: 'Firm',   width: 0.3 },
        { header: 'Clicks', width: 0.15, align: 'right' },
      ],
      metrics.jobs.topClicked.map((j) => [j.title, j.firm, num(j.clicks)])
    );
  }

  // ── News ──
  sectionHeading(doc, 'Law News');
  keyValue(doc, 'Articles added today', num(metrics.news?.newToday));
  doc.moveDown(0.4);
  table(doc,
    [
      { header: 'Headline', width: 0.72 },
      { header: 'Source',   width: 0.28 },
    ],
    (metrics.news?.headlines || []).map((h) => [h.title, h.sourceName || '']),
    { emptyText: 'No news articles recorded for this day.' }
  );

  // ── Students ──
  sectionHeading(doc, 'Students');
  keyValue(doc, 'Total students', num(metrics.students?.total));
  keyValue(doc, 'New sign-ups today', num(metrics.students?.newToday));
  keyValue(doc, 'Active today', num(metrics.students?.activeToday));

  // ── Errors ──
  sectionHeading(doc, 'Errors');
  table(doc,
    [
      { header: 'Endpoint', width: 0.75 },
      { header: 'Count',    width: 0.25, align: 'right' },
    ],
    (metrics.errors?.byEndpoint || []).map((e) => [e.endpoint, num(e.count)]),
    { emptyText: 'No errors logged today.' }
  );

  paginate(doc, 'Voxera For Law — internal report. Not for distribution.');
  doc.end();
  return doc;
}

// ── Monthly report ─────────────────────────────────────────────────────────

/**
 * @param {object} m - the object returned by adminStats.buildMonthlyMetrics
 * @param {{ inProgress?: boolean }} opts
 */
function buildMonthlyPdf(m, { inProgress = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });

  titleBlock(
    doc,
    `Monthly Report — ${prettyMonth(m.month)}`,
    inProgress
      ? `Month in progress — ${m.daysCovered} day(s) so far. Generated ${nowIst()}.`
      : `Complete month, ${m.daysCovered} day(s) of data. Generated ${nowIst()}.`
  );

  sectionHeading(doc, 'Summary');
  keyValue(doc, 'Total AI cost',              inr(m.tokens?.costInr));
  keyValue(doc, 'Total AI calls',             num(m.tokens?.calls));
  keyValue(doc, 'Tokens in / out',            `${num(m.tokens?.totalIn)}  /  ${num(m.tokens?.totalOut)}`);
  keyValue(doc, 'Students at month end',      num(m.students?.total));
  keyValue(doc, 'New sign-ups this month',    num(m.students?.newThisMonth));
  keyValue(doc, 'Busiest day (active students)', m.highlights?.busiestDay
    ? `${prettyDate(m.highlights.busiestDay.date)} — ${num(m.highlights.busiestDay.activeStudents)}`
    : '—');
  keyValue(doc, 'Costliest day', m.highlights?.costliestDay
    ? `${prettyDate(m.highlights.costliestDay.date)} — ${inr(m.highlights.costliestDay.costInr)}`
    : '—');
  keyValue(doc, 'New job listings',           num(m.jobs?.newListings));
  keyValue(doc, 'Apply clicks',               num(m.jobs?.applyClicks));
  keyValue(doc, 'News articles',              num(m.news?.articles));
  keyValue(doc, 'Errors logged',              num(m.errors?.total));

  sectionHeading(doc, 'AI usage by feature');
  table(doc,
    [
      { header: 'Feature',    width: 0.34 },
      { header: 'Calls',      width: 0.14, align: 'right' },
      { header: 'Tokens in',  width: 0.17, align: 'right' },
      { header: 'Tokens out', width: 0.17, align: 'right' },
      { header: 'Cost',       width: 0.18, align: 'right' },
    ],
    (m.tokens?.byFeature || []).map((f) => [
      f.label || labelFor(f.feature), num(f.calls), num(f.tokensIn), num(f.tokensOut), inr(f.costInr),
    ]),
    { emptyText: 'No AI calls were made this month.' }
  );

  sectionHeading(doc, 'Feature usage');
  table(doc,
    [
      { header: 'Feature', width: 0.7 },
      { header: 'Times used', width: 0.3, align: 'right' },
    ],
    (m.features || []).map((f) => [f.label, num(f.count)])
  );

  sectionHeading(doc, 'Day by day');
  table(doc,
    [
      { header: 'Date',            width: 0.28 },
      { header: 'AI calls',        width: 0.16, align: 'right' },
      { header: 'Cost',            width: 0.22, align: 'right' },
      { header: 'Active students', width: 0.18, align: 'right' },
      { header: 'Apply clicks',    width: 0.16, align: 'right' },
    ],
    (m.daily || []).map((d) => [
      prettyDate(d.date), num(d.aiCalls), inr(d.costInr), num(d.activeStudents), num(d.applyClicks),
    ])
  );

  paginate(doc, 'Voxera For Law — internal report. Not for distribution.');
  doc.end();
  return doc;
}

module.exports = { buildDailyPdf, buildMonthlyPdf, inr, num, prettyDate, prettyMonth };
