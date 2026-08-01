/**
 * otp.worker.js — background email sender.
 * Handles OTP (password reset) and welcome (new account) emails via AWS SES.
 * Uses aws-sdk v2, matching package.json. Region and sender come from .env.

 */
require('dotenv').config();

const { Worker } = require('bullmq');
const AWS = require('aws-sdk'); 

const ses = new AWS.SES({ region: process.env.AWS_REGION });
const SENDER_EMAIL = process.env.SES_FROM_EMAIL;

const sendEmail = async ({ to, subject, body }) => {
  await ses.sendEmail({
    Source: SENDER_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: body } }
    }
  }).promise();
};

const connection = require('../config/redisConnection');

const otpWorker = new Worker('send-otp-email', async (job) => {
  const { email, otp } = job.data;
  await sendEmail({
    to: email,
    subject: 'Your VFL password reset code',
    body: `Your one-time code is ${otp}. It expires in 10 minutes.`
  });
}, { connection, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

// Rate-limited specifically: a 500-student bulkImportStudents.js run queues
// 500 jobs almost instantly, but SES's sending rate is capped by AWS (1/sec
// in sandbox; a modest fixed rate — commonly ~14/sec — even after production
// access is granted, until usage history raises it). Without this, BullMQ
// would fire jobs as fast as it could pull them and SES would start
// throttling/erroring mid-batch. otpWorker doesn't need this: it's only ever
// triggered one-at-a-time by a real user's password-reset click, never in a
// bulk burst. Both values overridable via .env if SES's actual limits change.
const WELCOME_RATE_MAX = parseInt(process.env.SES_SEND_RATE_MAX || '1', 10);
const WELCOME_RATE_DURATION_MS = parseInt(process.env.SES_SEND_RATE_DURATION_MS || '1100', 10);

const welcomeWorker = new Worker('send-welcome-email', async (job) => {
  const { email, password } = job.data;
  await sendEmail({
    to: email,
    subject: 'Your Voxera For Law account is ready',
    body: `Welcome to Voxera For Law.\n\nYour login email: ${email}\nYour temporary password: ${password}\n\nPlease log in and change your password as soon as possible.`
  });
}, {
  connection,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  limiter: { max: WELCOME_RATE_MAX, duration: WELCOME_RATE_DURATION_MS },
});

[otpWorker, welcomeWorker].forEach((w) => {
  w.on('completed', (job) => console.log(`${job.queueName} job ${job.id} done`));
  w.on('failed', (job, err) => console.error(`${job?.queueName} job ${job?.id} failed:`, err.message));
});

console.log('OTP + welcome-email workers started, listening for jobs...');