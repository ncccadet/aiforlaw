/**
 * bulkImportStudents.js
 *
 * ONE-TIME ADMIN SCRIPT — not part of the running app, never exposed as an API.
 * This is the real 500-student import `regenerateTestCredentials.js`'s own
 * header comment always said would come later — same core logic (random
 * password → bcrypt hash → insert), aimed at a real CSV instead of 2
 * hardcoded test emails, plus college creation and welcome-email queueing.
 *
 * Usage:
 *   node backend/scripts/bulkImportStudents.js <csvPath> --college "College Name" --contact-email admin@college.edu [--max-students 350] [--skip-email] [--dry-run]
 *
 * CSV format — flexible, both of these work:
 *   email
 *   student1@college.edu
 *   student2@college.edu
 *
 *   name,email
 *   Asha Rao,asha@college.edu
 *   Vikram Shah,vikram@college.edu
 *
 * Flags:
 *   --password P   Give EVERY account in this run the same password P instead
 *                  of a random one each. Added 2026-07-30 for the first
 *                  college demo, where mail delivery was not working yet and
 *                  the only way to get seventy students logged in inside one
 *                  session was to announce a single password out loud in the
 *                  room. That is the ONLY situation this flag is for.
 *
 *                  What it costs: any student can sign in as any classmate,
 *                  because knowing the password no longer proves who you are.
 *                  It is acceptable for a one-day supervised preview and for
 *                  nothing else. Disable or re-provision these accounts when
 *                  the session ends. Do not use this flag for a paying cohort.
 *   --skip-email   Create accounts + write the password CSV, but do NOT
 *                  enqueue welcome emails. Use this until SES is verified —
 *                  lets accounts exist and be tested/logged-in-as before
 *                  mail sending is actually working. Re-run with email
 *                  sending on later — already-created users are skipped
 *                  (ON CONFLICT DO NOTHING), so no duplicate accounts, but
 *                  note: without a fresh run against still-pending users,
 *                  nothing re-sends. Use sendWelcomeEmailsOnly.js (not yet
 *                  built) or re-run this on a filtered CSV of the students
 *                  who didn't get one, if that gap ever needs closing later.
 *   --dry-run      Parse + validate the CSV and print what WOULD happen.
 *                  No DB writes, no queue writes, no output file.
 *
 * What it does NOT do (by design, matching regenerateTestCredentials.js):
 *   - Never prints all 500 plaintext passwords to the console (too much to
 *     scroll/copy reliably) — writes them to a timestamped local CSV file
 *     instead, and tells you exactly where. That file contains plaintext
 *     passwords once, ever — treat it like a secret: send it via a secure
 *     channel to whoever is distributing credentials, then delete it.
 *   - Never resets a password for a student who already has an account
 *     (existing email → ON CONFLICT DO NOTHING → reported as "skipped",
 *     not overwritten) — re-running this script after a partial run or a
 *     mistake is always safe.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { Queue } = require('bullmq');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--college') args.college = argv[++i];
    else if (a === '--contact-email') args.contactEmail = argv[++i];
    else if (a === '--max-students') args.maxStudents = parseInt(argv[++i], 10);
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--skip-email') args.skipEmail = true;
    else if (a === '--dry-run') args.dryRun = true;
    else args._.push(a);
  }
  return args;
}

// Deliberately no CSV library dependency for one script — simple splitter,
// good enough for "name,email" or bare "email" rows. Trims whitespace,
// skips blank lines, tolerates a header row (detected by not containing '@').
function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    const emailPart = parts.find((p) => p.includes('@'));
    if (!emailPart) continue; // header row or junk line — skip
    const email = emailPart.toLowerCase();
    const name = parts.length > 1 ? parts.find((p) => p !== emailPart) || null : null;
    rows.push({ email, name });
  }
  return rows;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < length; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

async function findOrCreateCollege({ name, contactEmail, maxStudents }) {
  const existing = await pool.query(`SELECT college_id, name FROM colleges WHERE name = $1`, [name]);
  if (existing.rowCount > 0) {
    console.log(`Using existing college "${existing.rows[0].name}" (${existing.rows[0].college_id})`);
    return existing.rows[0].college_id;
  }
  const res = await pool.query(
    `INSERT INTO colleges (name, contact_email, max_students) VALUES ($1, $2, $3) RETURNING college_id`,
    [name, contactEmail, maxStudents || 350]
  );
  console.log(`Created new college "${name}" (${res.rows[0].college_id})`);
  return res.rows[0].college_id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = args._[0];

  if (!csvPath) {
    console.error('Usage: node bulkImportStudents.js <csvPath> --college "Name" --contact-email admin@college.edu [--max-students 350] [--skip-email] [--dry-run]');
    process.exit(1);
  }
  if (!args.dryRun && (!args.college || !args.contactEmail)) {
    console.error('--college and --contact-email are required unless --dry-run is set.');
    process.exit(1);
  }

  if (args.password) {
    console.log('\n!! --password is set: every account created in this run will share ONE password.');
    console.log('!! Any student can therefore log in as any other. Only acceptable for a supervised');
    console.log('!! one-day preview. Re-provision these accounts afterwards.\n');
  }

  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const rows = parseCsv(raw);
  console.log(`Parsed ${rows.length} row(s) from ${csvPath}`);

  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const row of rows) {
    if (!isValidEmail(row.email)) { invalid.push(row); continue; }
    if (seen.has(row.email)) { invalid.push({ ...row, reason: 'duplicate in CSV' }); continue; }
    seen.add(row.email);
    valid.push(row);
  }

  console.log(`Valid: ${valid.length} · Invalid/duplicate (skipped): ${invalid.length}`);
  if (invalid.length) console.log('Invalid rows:', invalid.slice(0, 20));

  if (args.dryRun) {
    console.log('\n--dry-run set — no DB writes, no emails queued. Sample of first 5 valid rows:');
    console.table(valid.slice(0, 5));
    await pool.end();
    return;
  }

  const collegeId = await findOrCreateCollege({
    name: args.college,
    contactEmail: args.contactEmail,
    maxStudents: args.maxStudents,
  });

  let welcomeQueue = null;
  let redisConnection = null;
  if (!args.skipEmail) {
    // redisConnection.js exports one SHARED ioredis instance reused by every
    // Queue/Worker in the app — Queue.close() only closes connections it
    // creates itself, so it never disconnects a connection that was handed
    // to it. Without an explicit .quit() here the process hangs forever
    // after finishing (found via a real local test run, not assumed).
    redisConnection = require('../config/redisConnection');
    welcomeQueue = new Queue('send-welcome-email', { connection: redisConnection });
  } else {
    console.log('--skip-email set — accounts will be created but NO welcome emails will be queued.');
  }

  const created = [];
  const skipped = [];
  const failed = [];

  // With --password every account shares one hash, so bcrypt is run ONCE
  // rather than seventy times. bcrypt at cost 10 is ~100ms of deliberate CPU
  // burn per call; hashing the same string repeatedly would add several
  // seconds of pure waste to a run being done under time pressure.
  const sharedHash = args.password ? await bcrypt.hash(args.password, 10) : null;

  for (const { email } of valid) {
    try {
      const plainPassword = args.password || generatePassword();
      const hashedPassword = sharedHash || (await bcrypt.hash(plainPassword, 10));
      const res = await pool.query(
        `INSERT INTO users (college_id, email, hashed_password, role)
         VALUES ($1, $2, $3, 'student')
         ON CONFLICT (email) DO NOTHING
         RETURNING user_id`,
        [collegeId, email, hashedPassword]
      );
      if (res.rowCount === 0) { skipped.push({ email, reason: 'already exists' }); continue; }

      created.push({ email, password: plainPassword });
      if (welcomeQueue) await welcomeQueue.add('send-welcome-email', { email, password: plainPassword });
    } catch (err) {
      failed.push({ email, reason: err.message });
    }
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `bulk_import_${stamp}.csv`);
  const csvLines = ['email,password', ...created.map((c) => `${c.email},${c.password}`)];
  fs.writeFileSync(outPath, csvLines.join('\n'));

  console.log('\n=== Bulk import complete ===');
  console.log(`Created:  ${created.length}`);
  console.log(`Skipped (already existed): ${skipped.length}`);
  console.log(`Failed:   ${failed.length}`);
  if (failed.length) console.log('Failures:', failed.slice(0, 20));
  console.log(`Welcome emails queued: ${welcomeQueue ? created.length : 0}`);
  console.log(`\nPlaintext credentials written to: ${outPath}`);
  console.log('This file contains real passwords in plain text. Send it only through a secure channel and delete it once distributed/no longer needed.');

  if (welcomeQueue) await welcomeQueue.close();
  if (redisConnection) await redisConnection.quit();
  await pool.end();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
