CREATE TABLE grove_instance_keys (
  kid text PRIMARY KEY,
  private_key_pem text NOT NULL,
  public_jwk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
