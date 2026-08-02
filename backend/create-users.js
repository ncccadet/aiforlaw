/**
 * create-users.js — one-time script to seed two student accounts.
 * Run from the backend directory:
 *   node create-users.js
 *
 * Requires DATABASE_URL to be set (reads from .env automatically via dotenv).
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const USERS = [
  { email: 'siddhant@gmail.com', password: '12345', name: 'Siddhant' },
  { email: 'shiven@gmail.com',   password: '12345', name: 'Shiven'   },
];

async function createUser({ email, password }) {
  // Check if already exists
  const { rows: existing } = await pool.query(
    'SELECT user_id FROM users WHERE email = $1',
    [email]
  );
  if (existing.length > 0) {
    console.log('[SKIP] ' + email + ' already exists (user_id=' + existing[0].user_id + ')');
    return;
  }

  const hashed_password = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (email, hashed_password, role, college_id, active_session_version) VALUES ($1, $2, \'student\', NULL, 0) RETURNING user_id, email, role',
    [email, hashed_password]
  );
  const user = rows[0];
  console.log('[CREATED] ' + email + ' -> user_id=' + user.user_id + ', role=' + user.role);
}

(async () => {
  try {
    for (const u of USERS) {
      await createUser(u);
    }
    console.log('\nDone. Login credentials:');
    for (const u of USERS) {
      console.log('  Email: ' + u.email + '  Password: ' + u.password);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
