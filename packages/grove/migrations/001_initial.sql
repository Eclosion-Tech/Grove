CREATE TABLE grove_schema_versions (
  tenant_id text NOT NULL,
  site_id text NOT NULL,
  environment text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, environment, version)
);

CREATE TABLE grove_documents (
  tenant_id text NOT NULL,
  site_id text NOT NULL,
  environment text NOT NULL,
  id text NOT NULL,
  type text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL,
  draft jsonb NOT NULL,
  published jsonb,
  published_revision integer,
  published_schema_version integer,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, site_id, environment, id),
  FOREIGN KEY (tenant_id, site_id, environment, schema_version)
    REFERENCES grove_schema_versions (tenant_id, site_id, environment, version)
);
CREATE INDEX grove_documents_by_type ON grove_documents (tenant_id, site_id, environment, type, id);
CREATE INDEX grove_documents_published ON grove_documents USING gin (published);

CREATE TABLE grove_document_history (
  tenant_id text NOT NULL,
  site_id text NOT NULL,
  environment text NOT NULL,
  document_id text NOT NULL,
  revision integer NOT NULL,
  schema_version integer NOT NULL,
  data jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'save', 'publish', 'unpublish', 'restore')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, environment, document_id, revision),
  FOREIGN KEY (tenant_id, site_id, environment, document_id)
    REFERENCES grove_documents (tenant_id, site_id, environment, id)
);
