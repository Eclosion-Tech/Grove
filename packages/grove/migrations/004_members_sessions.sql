CREATE TABLE grove_members (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  id text NOT NULL,
  email text NOT NULL,
  subject text,
  role text NOT NULL CHECK (role IN ('owner','developer','publisher','editor','viewer')),
  permissions jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  PRIMARY KEY (tenant_id, site_id, environment, id),
  UNIQUE (tenant_id, site_id, environment, email)
);
CREATE UNIQUE INDEX grove_members_subject ON grove_members (tenant_id, site_id, environment, subject) WHERE subject IS NOT NULL;
CREATE TABLE grove_sessions (
  id_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('login','session')),
  subject text,
  email text,
  csrf text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX grove_sessions_expiry ON grove_sessions (expires_at);
