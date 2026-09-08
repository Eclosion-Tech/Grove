CREATE TABLE grove_media (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  id text NOT NULL, storage_key text NOT NULL UNIQUE, filename text NOT NULL, mime_type text NOT NULL,
  bytes integer NOT NULL, width integer NOT NULL, height integer NOT NULL,
  revision integer NOT NULL DEFAULT 1, alt jsonb NOT NULL DEFAULT '{}', caption jsonb NOT NULL DEFAULT '{}',
  focal_point jsonb NOT NULL DEFAULT '{"x":0.5,"y":0.5}',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, site_id, environment, id)
);
CREATE TABLE grove_relationships (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  source_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('draft','published')),
  path text NOT NULL, target_kind text NOT NULL CHECK (target_kind IN ('document','asset')), target_id text NOT NULL, target_type text,
  PRIMARY KEY (tenant_id, site_id, environment, source_id, channel, path),
  FOREIGN KEY (tenant_id, site_id, environment, source_id) REFERENCES grove_documents (tenant_id, site_id, environment, id)
);
CREATE INDEX grove_relationships_target ON grove_relationships (tenant_id, site_id, environment, target_kind, target_id, channel);
ALTER TABLE grove_document_history DROP CONSTRAINT grove_document_history_action_check;
ALTER TABLE grove_document_history ADD CONSTRAINT grove_document_history_action_check CHECK (action IN ('create','save','publish','unpublish','restore','migrate'));
CREATE TABLE grove_media_history (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL, asset_id text NOT NULL,
  revision integer NOT NULL, action text NOT NULL, metadata jsonb NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, environment, asset_id, revision),
  FOREIGN KEY (tenant_id, site_id, environment, asset_id) REFERENCES grove_media (tenant_id, site_id, environment, id)
);
