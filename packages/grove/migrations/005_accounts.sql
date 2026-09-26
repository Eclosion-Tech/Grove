CREATE TABLE grove_accounts (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text,
  invitation_hash text UNIQUE,
  invitation_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);
