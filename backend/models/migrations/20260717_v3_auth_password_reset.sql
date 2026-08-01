-- Migration: add single-device login support + password reset flow
-- Adds active_session_version to users (token versioning for single-device enforcement)
-- Creates password_resets table (OTP storage for forgot-password flow)

ALTER TABLE users
  ADD COLUMN active_session_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE password_resets (
  reset_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  otp_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_resets_user ON password_resets(user_id);
