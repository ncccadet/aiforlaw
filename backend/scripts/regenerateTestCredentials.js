/**
 * regenerateTestCredentials.js
 *
 * ONE-TIME ADMIN SCRIPT — not part of the running app, never exposed as an API.
 * Run manually from the terminal: node backend/scripts/regenerateTestCredentials.js
 *
 * What it does:
 *   - Picks a small hardcoded list of existing student emails (our 2 test students)
 *   - Generates a random plain-text password for each
 *   - Bcrypt-hashes it and UPDATEs the users table
 *   - Prints the PLAIN password to the console (only place it's ever visible)
 *
 * This is the same core logic the real 500-student bulk import will use later,
 * just aimed at 2 people and printed instead of exported to CSV.
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
// The 2 test students we're using for this trial run.
// (Swap this list for a CSV loader when we do the real 500-student import.)
const TEST_STUDENTS = [
  'student1@testcollegea.edu',
  'student1@testcollegeb.edu',
];

function generatePassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < length; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

async function main() {
  const results = [];

  for (const email of TEST_STUDENTS) {
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const res = await pool.query(
      `UPDATE users SET hashed_password = $1 WHERE email = $2 RETURNING email, college_id`,
      [hashedPassword, email]
    );

    if (res.rowCount === 0) {
      console.log(`⚠️  No user found with email ${email} — skipped.`);
      continue;
    }

    results.push({ email, plainPassword });
  }

  console.log('\n=== Test Credentials (share these manually, then discard) ===\n');
  console.table(results);

  await pool.end();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});