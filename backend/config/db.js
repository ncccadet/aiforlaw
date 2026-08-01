/**
 * db.js — shared Postgres pool + college-scoped query helper.
 *
 * WHY THIS EXISTS: every controller today creates its OWN `new Pool(...)`
 * (auth.controller.js, jobBoard.controller.js, etc). That already works, but
 * it means there's no single place to route a query "as college X" through
 * Postgres's Row Level Security policies added in
 * migrations/20260726_rls_policies.sql. Those policies check a per-connection
 * setting called app.current_college_id — plain pool.query() never sets it,
 * so RLS silently falls back to "unrestricted" for every request, same as
 * before this file existed.
 *
 * queryAsCollege(collegeId, text, params) is the fix: it checks out ONE
 * client, opens a transaction, sets app.current_college_id to the student's
 * own college_id (from req.user.college_id, set by auth.middleware.js after
 * verifying their JWT), runs the query, commits, and releases the client.
 * If the query fails, it rolls back instead of committing.
 *
 * This file does not change any existing controller by itself — it's an
 * additive helper. Switching a controller's `pool.query(...)` calls over to
 * `queryAsCollege(req.user.college_id, ...)` is what actually turns on the
 * RLS protection for that feature's requests.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

/**
 * Run one query scoped to a specific college via Postgres RLS.
 * @param {string} collegeId - req.user.college_id from the verified JWT. Never
 *   accept this from a request body/query param — it must come from the
 *   token, or a student could pass any college_id they like.
 * @param {string} text - SQL text, using $1/$2/... placeholders as normal.
 * @param {Array} params
 */
async function queryAsCollege(collegeId, text, params = []) {
  if (!collegeId) {
    throw new Error('queryAsCollege called without a collegeId — refusing to run unscoped.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL only lasts for this transaction, on this one checked-out
    // client — safe even though the underlying connection gets reused by
    // other requests later, since it resets at COMMIT/ROLLBACK.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_college_id', collegeId]);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run several queries as one atomic college-scoped transaction — use when a
 * request needs more than one statement (e.g. insert then update) that must
 * all see the same RLS context and either all succeed or all roll back.
 * @param {string} collegeId
 * @param {(client: import('pg').PoolClient) => Promise<any>} work
 */
async function withCollegeTransaction(collegeId, work) {
  if (!collegeId) {
    throw new Error('withCollegeTransaction called without a collegeId — refusing to run unscoped.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_college_id', collegeId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, queryAsCollege, withCollegeTransaction };
