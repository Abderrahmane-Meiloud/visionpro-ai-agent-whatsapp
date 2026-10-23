CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  preferred_language TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT UNIQUE NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  mode TEXT NOT NULL DEFAULT 'AI' CHECK (mode IN ('AI','HUMAN_PENDING','HUMAN','PAUSED')),
  current_summary TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_inbound_at TIMESTAMPTZ,
  assigned_user TEXT,
  stt_failures INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id),
  whatsapp_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CUSTOMER','AI','HUMAN','SYSTEM')),
  message_type TEXT NOT NULL DEFAULT 'TEXT',
  text TEXT,
  transcription TEXT,
  media_meta JSONB,
  processing_status TEXT NOT NULL DEFAULT 'DONE',
  delivery_status TEXT,
  model_name TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages (processing_status) WHERE processing_status IN ('PENDING','PROCESSING');

CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'meta',
  event_key TEXT UNIQUE,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  error TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_articles (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  version INT NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocabulary (
  id BIGSERIAL PRIMARY KEY,
  term TEXT NOT NULL,
  alternates JSONB NOT NULL DEFAULT '[]',
  language TEXT,
  meaning TEXT,
  examples JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS handoffs (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by TEXT,
  accepted_at TIMESTAMPTZ,
  returned_to_ai_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT,
  tool_name TEXT NOT NULL,
  request JSONB,
  response JSONB,
  status TEXT NOT NULL,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  old_value JSONB,
  new_value JSONB,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- audit history is immutable
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_change ON audit_logs;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
