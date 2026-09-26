CREATE TABLE grove_connections (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  id text NOT NULL,
  endpoint text NOT NULL,
  module_id text NOT NULL,
  label text NOT NULL,
  catalog_revision text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, environment, id)
);
CREATE TABLE grove_role_grants (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  role text NOT NULL CHECK (role IN ('developer','publisher','editor','viewer')),
  permissions jsonb NOT NULL DEFAULT '[]',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, environment, role)
);
