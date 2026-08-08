/**
 * seedDraftLibraryPdfs.js — one-time seed: download the real PDF specimens
 * used in Drafting Lab's Step 1 library and upload them to S3.
 *
 * WHY THIS IS A SEPARATE SCRIPT, NOT RUN FROM THE BUILD SANDBOX:
 * The sandbox this feature was built in has an allowlisted outbound network
 * (package registries only) — it cannot reach court/government websites OR
 * AWS's API endpoints directly. Both were confirmed to time out. Run this
 * script instead from a place that has real internet + the real AWS
 * credentials already in `.env` — staging or production (matches how every
 * other AWS-touching script in this project already gets its credentials:
 * from the environment, never hardcoded — see project's Security
 * Non-Negotiables).
 *
 * USAGE:
 *   cd backend && node scripts/seedDraftLibraryPdfs.js
 *
 * Requires in .env: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * S3_BUCKET_FILES — same variables resumeAnalyzer.controller.js already uses.
 *
 * Keys uploaded here MUST exactly match the `sourcePdfS3Key` /
 * `scannedOfficialPdfS3Key` / `supportingPdfS3Key` values already set in
 * backend/data/draftLibrary.data.js — the controller's getLibrary() reads
 * those same keys to build presigned view URLs. If you change a key here,
 * change it there too.
 */
require('dotenv').config();
const https = require('https');
const AWS = require('aws-sdk');

const s3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: 'v4', sslEnabled: true });
const BUCKET = process.env.S3_BUCKET_FILES;

// Each source URL was manually verified downloadable (2026-07-23) by the
// founder, outside this sandbox — see _decisions/decisions-log.md.
const SPECIMENS = [
  { key: 'draft-library/vakalatnama/delhi.pdf',
    url: 'https://delhihighcourt.nic.in/files/announcements/downloadfile_adupync8.pdf' },
  { key: 'draft-library/vakalatnama/maharashtra-ecourts-practice-form.pdf',
    url: 'https://ecourts.gov.in/ecourts_home/forms/Vakalatnama%20form.pdf' },
  { key: 'draft-library/vakalatnama/maharashtra-form5-official-scanned.pdf',
    url: 'https://bombayhighcourt.gov.in/bhc/libweb/bhcrule/OSRules/forms/No.5.pdf' },
  { key: 'draft-library/affidavit/delhi.pdf',
    url: 'https://images.assettype.com/barandbench/import/2019/01/Writ-Petition-Baljeet-Malik-vs-State.pdf' },
  { key: 'draft-library/affidavit/delhi-hc-rules-ch12-oaths.pdf',
    url: 'https://delhihighcourt.nic.in/files/2024-04/courtrulefile_r43dp25p.pdf' },
  { key: 'draft-library/affidavit/maharashtra.pdf',
    url: 'https://clpr.org.in/wp-content/uploads/2017/06/Online-Version-Final-Chamber-Summons-1.pdf' },
];

const downloadBuffer = (url, redirectsLeft = 5) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
      res.resume();
      return resolve(downloadBuffer(res.headers.location, redirectsLeft - 1));
    }
    if (res.statusCode !== 200) {
      res.resume();
      return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
    }
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

async function seed() {
  if (!BUCKET) throw new Error('S3_BUCKET_FILES is not set — check .env before running this.');

  for (const s of SPECIMENS) {
    try {
      console.log(`Downloading ${s.url} ...`);
      const buf = await downloadBuffer(s.url);
      console.log(`  got ${buf.length} bytes, uploading to s3://${BUCKET}/${s.key}`);
      await s3.putObject({
        Bucket: BUCKET,
        Key: s.key,
        Body: buf,
        ContentType: 'application/pdf',
      }).promise();
      console.log(`  ✓ uploaded ${s.key}`);
    } catch (err) {
      // One bad source should never abort the rest of the seed run.
      console.error(`  ✗ FAILED for ${s.key} (${s.url}):`, err.message);
    }
  }
  console.log('Done. Verify in draftLibrary.data.js that the keys above match sourcePdfS3Key/scannedOfficialPdfS3Key/supportingPdfS3Key exactly.');
}

seed().catch((err) => { console.error(err); process.exit(1); });
