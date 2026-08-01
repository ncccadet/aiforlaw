/**
 * createAdminUser.js — creates (or updates) the single founder admin account.
 *
 * Run MANUALLY over SSH, once per environment. There is deliberately no admin
 * signup endpoint and no admin password-reset endpoint: the only way an admin
 * account can come into existence is somebody with server access running this.
 *
 *   node scripts/createAdminUser.js you@example.com 'a-long-password'
 *
 * The password is read from argv rather than prompted because this is run
 * non-interactively over SSH. Prefix the command with a SPACE so it does not
 * land in ~/.bash_history:
 *
 *    node scripts/createAdminUser.js you@example.com 'a-long-password'
 *   ^ that leading space matters (requires HISTCONTROL=ignorespace, default on Ubuntu)
 *
 * The email must ALSO be in the ADMIN_EMAILS env var, or login is refused —
 * two independent locks, by design (see _contracts/09-admin-panel.md). This
 * script refuses to run if the email is not on that list, so you cannot end up
 * with an admin row that can never log in and not understand why.
 *
 * The admin is placed in a dedicated "Voxera Internal" college with
 * max_students = 0, so the founder's own account never inflates a real
 * college's student count. Every report query already filters role <> 'admin'
 * as well — belt and braces.
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');

const INTERNAL_COLLEGE_NAME = 'Voxera Internal';

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: node scripts/createAdminUser.js <email> <password>');
    process.exit(1);
  }
  if (password.length < 12) {
    // This account can read every college's data. A short password on it is
    // not a small problem.
    console.error('Refusing: admin password must be at least 12 characters.');
    process.exit(1);
  }

  const allowed = (process.env.ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email.trim().toLowerCase())) {
    console.error(
      `Refusing: "${email}" is not in ADMIN_EMAILS.\n` +
      `Add it to the environment first (AWS SSM — never in a file), restart the API, then re-run this.\n` +
      `Current ADMIN_EMAILS has ${allowed.length} entry/entries.`
    );
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reuse the internal college if it already exists — running this script
    // twice must not create a second one.
    const existing = await client.query(
      'SELECT college_id FROM colleges WHERE name = $1',
      [INTERNAL_COLLEGE_NAME]
    );
    let collegeId;
    if (existing.rows.length > 0) {
      collegeId = existing.rows[0].college_id;
    } else {
      const created = await client.query(
        `INSERT INTO colleges (name, plan_tier, max_students, contact_email)
         VALUES ($1, 'internal', 0, $2) RETURNING college_id`,
        [INTERNAL_COLLEGE_NAME, email]
      );
      collegeId = created.rows[0].college_id;
      console.log(`Created internal college ${collegeId}.`);
    }

    const hashed = await bcrypt.hash(password, 10);

    // ON CONFLICT on the email unique constraint: re-running this with a new
    // password is the supported way to rotate the admin password, since there
    // is no reset endpoint. It also bumps active_session_version, which
    // immediately invalidates any admin session that is currently open.
    const { rows } = await client.query(
      `INSERT INTO users (college_id, email, hashed_password, role, email_digest)
       VALUES ($1, $2, $3, 'admin', FALSE)
       ON CONFLICT (email) DO UPDATE
         SET hashed_password = EXCLUDED.hashed_password,
             role = 'admin',
             college_id = EXCLUDED.college_id,
             active_session_version = users.active_session_version + 1
       RETURNING user_id, email, role`,
      [collegeId, email, hashed]
    );

    await client.query('COMMIT');
    console.log(`Admin ready: ${rows[0].email} (${rows[0].user_id})`);
    console.log('Any previously open admin session has been invalidated.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Failed:', err); process.exit(1); });
