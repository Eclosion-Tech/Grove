CREATE TABLE grove_admin_actions (
  tenant_id text NOT NULL, site_id text NOT NULL, environment text NOT NULL,
  actor_id text NOT NULL, request_id text NOT NULL,
  module_id text NOT NULL, resource_id text NOT NULL, action_id text NOT NULL, record_id text NOT NULL,
  input_hash text NOT NULL, status text NOT NULL CHECK (status IN ('running','succeeded','uncertain','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY (tenant_id,site_id,environment,actor_id,request_id)
);
CREATE UNIQUE INDEX grove_admin_active_target ON grove_admin_actions (tenant_id,site_id,environment,module_id,resource_id,record_id) WHERE status IN ('running','uncertain');
CREATE INDEX grove_admin_actor_activity ON grove_admin_actions (tenant_id,site_id,environment,actor_id,module_id,resource_id,created_at DESC);
