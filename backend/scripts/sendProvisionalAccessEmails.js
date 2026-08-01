/**
 * sendProvisionalAccessEmails.js
 *
 * ONE-TIME ADMIN SCRIPT — not part of the running app, never exposed as an
 * API, never imported by anything. Run by hand, from a machine that has the
 * credentials file on it.
 *
 * WHY THIS EXISTS INSTEAD OF THE NORMAL WELCOME-EMAIL QUEUE
 * ---------------------------------------------------------
 * The app sends transactional mail through SES (the `send-welcome-email`
 * BullMQ queue). SES is still in sandbox mode: it will only deliver to
 * addresses that have individually confirmed a verification link, which is
 * useless for a class list, and production access is an AWS support-case wait
 * measured in days, not hours.
 *
 * Founder decision (2026-07-30): the first cohort gets provisional access
 * today, so send this one batch over Gmail SMTP instead. That is a deliberate
 * stopgap for a batch of about seventy, NOT the product's mail path:
 *
 *   - Gmail's free sending cap is roughly 500 messages/day. Fine for one
 *     class list, hopeless at 350 students × any recurring email.
 *   - The From: address is a gmail.com address, not @voxeraforlaw.in.
 *   - Nothing here is queued, retried by a worker, or recorded in the app's
 *     email tables. If it fails, it fails in this terminal, in front of you.
 *
 * When SES production access comes through, this script's job is over. Use
 * the queue.
 *
 * SETUP (once)
 * ------------
 * A Gmail App Password is required — your normal account password will be
 * rejected by SMTP. Google account → Security → 2-Step Verification must be
 * ON → App passwords → generate one for "Mail". It is 16 characters.
 *
 *   export GMAIL_USER='aifortech9@gmail.com'
 *   export GMAIL_APP_PASSWORD='xxxxxxxxxxxxxxxx'
 *
 * Do NOT put these in .env and do NOT commit them anywhere. They are read
 * from the environment only, same rule as every other secret in this repo.
 *
 * USAGE
 * -----
 *   node backend/scripts/sendProvisionalAccessEmails.js \
 *     --credentials backend/scripts/output/bulk_import_<stamp>.csv \
 *     --roster students-army-law-college.csv \
 *     [--limit 2] [--dry-run]
 *
 *   --credentials  the email,password CSV written by bulkImportStudents.js
 *   --roster       the name,email CSV that was fed to bulkImportStudents.js.
 *                  Optional — only used to greet students by name. A student
 *                  missing from it is greeted generically, never skipped.
 *   --limit N      send to the first N recipients only. ALWAYS do --limit 1
 *                  to yourself first: a bad template mailed to seventy
 *                  students cannot be recalled.
 *   --dry-run      render everything, connect to nothing, send nothing.
 *
 * RESUME SAFETY
 * -------------
 * Every successful send is appended to a log file next to the credentials CSV
 * before the next send is attempted. Re-running the script skips anyone
 * already in that log. So if Gmail throttles you at message forty, or the
 * laptop sleeps, you just run the exact same command again — the first forty
 * are not re-sent. The log records the address and timestamp only; passwords
 * are never written to it.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const APP_URL = 'https://www.voxeraforlaw.in';
const SUPPORT_EMAIL = 'aifortech9@gmail.com';

// Gmail drops connections that fire messages as fast as a loop can produce
// them, and a burst from a new sender is exactly what its abuse heuristics
// look for. One message every 1.5s means seventy students take under two
// minutes, which is fast enough that nobody is waiting and slow enough that
// nothing trips.
const DELAY_MS = 1500;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--credentials') args.credentials = argv[++i];
    else if (a === '--roster') args.roster = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** Minimal name,email / email,password reader. Header row detected by the
 *  absence of an '@', same convention as bulkImportStudents.js. */
function readCsv(file) {
  return fs
    .readFileSync(path.resolve(file), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => l.includes('@'))
    .map((l) => l.split(',').map((p) => p.trim()));
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The message. Deliberately plain: a student receiving an unexpected email
 * containing a password needs to recognise instantly who sent it and why, and
 * a heavily designed HTML template reads more like phishing than a plain one
 * does. Both a text and an HTML part are sent — some Indian mobile mail
 * clients still render text/plain by default, and a credentials mail that
 * arrives as raw markup is a support call.
 */
function buildMessage({ name, email, password }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';

  const text = `${greeting}

Your provisional access to Voxera For Law is ready. This is a preview for
your feedback — please use it, then tell us what worked and what did not.

  Website:  ${APP_URL}
  Email:    ${email}
  Password: ${password}

Please change nothing about this email except keeping it safe — the password
above is yours alone. Do not share it with classmates; each of you has a
separate account and separate work.

What you can try:
  - Exam Prep, with question papers from your own university
  - Court Simulation, argue a case against an AI opposing counsel
  - AI Interviewer, practise a legal job interview out loud
  - Drafting Lab, Resume Analyzer and Resume Builder
  - The Job Board, live legal jobs and internships

Some features have a small daily limit, which is normal and not a fault.

If you cannot log in, or anything behaves oddly, reply to this email and tell
us what you were doing when it happened. That is exactly the feedback we need.

Voxera For Law
${SUPPORT_EMAIL}
`;

  const html = `<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">
  <p>${escapeHtml(greeting)}</p>
  <p>Your provisional access to <strong>Voxera For Law</strong> is ready. This is a preview for your feedback — please use it, then tell us what worked and what did not.</p>
  <table cellpadding="6" style="background:#f5f5f5;border-radius:8px;margin:18px 0">
    <tr><td>Website</td><td><a href="${APP_URL}">${APP_URL}</a></td></tr>
    <tr><td>Email</td><td><strong>${escapeHtml(email)}</strong></td></tr>
    <tr><td>Password</td><td><strong>${escapeHtml(password)}</strong></td></tr>
  </table>
  <p>The password above is yours alone — please do not share it with classmates. Each of you has a separate account and separate work.</p>
  <p><strong>What you can try:</strong></p>
  <ul>
    <li>Exam Prep, with question papers from your own university</li>
    <li>Court Simulation — argue a case against an AI opposing counsel</li>
    <li>AI Interviewer — practise a legal job interview out loud</li>
    <li>Drafting Lab, Resume Analyzer and Resume Builder</li>
    <li>The Job Board — live legal jobs and internships</li>
  </ul>
  <p>Some features have a small daily limit. That is normal, not a fault.</p>
  <p>If you cannot log in, or anything behaves oddly, just reply to this email and tell us what you were doing when it happened. That is exactly the feedback we need.</p>
  <p style="color:#555">Voxera For Law<br><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
</div>`;

  return { subject: 'Your Voxera For Law access', text, html };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.credentials) {
    console.error('Missing --credentials <bulk_import_*.csv>. See the header of this file for usage.');
    process.exit(1);
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!args.dryRun && (!user || !pass)) {
    console.error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in the environment. See the header of this file.');
    process.exit(1);
  }

  // email → password, from bulkImportStudents.js's output.
  const creds = readCsv(args.credentials).map(([email, password]) => ({
    email: (email || '').toLowerCase(),
    password,
  }));

  // email → name, so the greeting is personal. Optional by design.
  const names = new Map();
  if (args.roster) {
    for (const [name, email] of readCsv(args.roster)) {
      if (email) names.set(email.toLowerCase(), name || null);
    }
  }

  // Anyone already sent to in a previous run of this exact batch.
  const logPath = args.credentials.replace(/\.csv$/, '') + '.sent.log';
  const alreadySent = new Set(
    fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(',')[0])
      : []
  );

  let queue = creds.filter((c) => c.email && c.password && !alreadySent.has(c.email));
  const resumedCount = creds.length - queue.length;
  if (args.limit) queue = queue.slice(0, args.limit);

  console.log(`Recipients in credentials file: ${creds.length}`);
  if (resumedCount) console.log(`Already sent in a previous run (skipping): ${resumedCount}`);
  console.log(`Will send now: ${queue.length}${args.dryRun ? ' (DRY RUN — nothing will be sent)' : ''}`);

  if (args.dryRun) {
    const sample = queue[0];
    if (sample) {
      const msg = buildMessage({ name: names.get(sample.email), ...sample });
      console.log(`\n--- preview to ${sample.email} ---\nSubject: ${msg.subject}\n\n${msg.text}`);
    }
    console.log('\nRecipients:', queue.map((q) => q.email).join(', '));
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  // Fail loudly on bad credentials BEFORE the loop, rather than discovering it
  // one rejected message at a time.
  await transporter.verify();
  console.log('SMTP connection verified.\n');

  let sent = 0;
  const failures = [];

  for (const { email, password } of queue) {
    const msg = buildMessage({ name: names.get(email), email, password });
    try {
      await transporter.sendMail({
        from: `"Voxera For Law" <${user}>`,
        to: email,
        replyTo: SUPPORT_EMAIL,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      // Written BEFORE the next send, so a crash mid-batch cannot cause a
      // duplicate on resume. Address and time only — never the password.
      fs.appendFileSync(logPath, `${email},${new Date().toISOString()}\n`);
      sent++;
      console.log(`  sent  ${sent}/${queue.length}  ${email}`);
    } catch (err) {
      failures.push({ email, reason: err.message });
      console.error(`  FAIL  ${email} — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  transporter.close();

  console.log('\n=== Send complete ===');
  console.log(`Sent:   ${sent}`);
  console.log(`Failed: ${failures.length}`);
  if (failures.length) {
    console.log('Failures (re-run the same command to retry only these):');
    failures.forEach((f) => console.log(`  ${f.email} — ${f.reason}`));
  }
  console.log(`\nSend log: ${logPath}`);
  console.log('Reminder: the credentials CSV holds plaintext passwords. Delete it once the batch is out.');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
