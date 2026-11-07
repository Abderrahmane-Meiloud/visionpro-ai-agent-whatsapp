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

-- ============================================================================
-- P2-A: team management (individual staff accounts, sessions, RBAC, assignment)
-- All additive. Existing tables/columns and the Basic-auth bridge are untouched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                       -- scrypt, encoded scheme string (never plaintext)
  role TEXT NOT NULL CHECK (role IN ('admin','agent','viewer')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,                   -- sha256(raw cookie token); raw token is never stored
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- conversation ownership (additive; assigned_user username column stays for list/bridge compatibility)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id BIGINT REFERENCES users(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- ============================================================================
-- P2-B: advanced inbox + knowledge lifecycle. All additive; AI pipeline, message
-- history and the Basic-auth bridge are untouched. Conversation `status` is an inbox
-- workflow state only (it does NOT gate AI processing — that stays governed by `mode`).
-- ============================================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'OPEN'
  CHECK (status IN ('OPEN','CLOSED','SNOOZED'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS conversations_status_idx ON conversations (status, last_message_at DESC);

-- Internal notes: staff-only. Kept in a SEPARATE table so they can never be sent to WhatsApp
-- nor appear in the AI conversation history (which reads only from `messages`).
CREATE TABLE IF NOT EXISTS conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_notes_conv_idx ON conversation_notes (conversation_id, id);

-- Knowledge lifecycle. `status` defaults to 'published' so existing rows behave exactly as before;
-- retrieval uses (active AND status='published'). `volatile_flag` records the volatile-content lint.
ALTER TABLE knowledge_articles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'
  CHECK (status IN ('draft','published','archived'));
ALTER TABLE knowledge_articles ADD COLUMN IF NOT EXISTS volatile_flag BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS knowledge_pub_idx ON knowledge_articles (status, active, category);

-- ============================================================================
-- P2-C: business integrations (local provider), orders, and approved templates.
-- All additive. The AI reads catalog facts via tools and may create DRAFT orders only;
-- confirmation/cancellation is staff-only and transactional. No external business system.
-- ============================================================================

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_prices (
  product_id BIGINT PRIMARY KEY REFERENCES products(id),
  currency TEXT NOT NULL DEFAULT 'MRU',
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory (
  product_id BIGINT PRIMARY KEY REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  items JSONB NOT NULL,              -- [{product_id, sku, name, qty, unit_amount}]
  currency TEXT NOT NULL DEFAULT 'MRU',
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,          -- 'AI' for drafts
  confirmed_by TEXT, confirmed_at TIMESTAMPTZ,
  cancelled_by TEXT, cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_conv_idx ON orders (conversation_id, id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, id DESC);

-- ============================================================================
-- Dashboard completeness pass (channel visibility, unread, retry — additive).
-- ============================================================================

-- A human staff member's last view of a conversation; compared against last_inbound_at to compute
-- "unread" in the conversation list. NULL means "never viewed" (unread if anything has arrived).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,                       -- human label
  meta_template_name TEXT NOT NULL,         -- name registered/approved in Meta
  language TEXT NOT NULL,
  category TEXT,
  body_preview TEXT NOT NULL,               -- preview with {{1}} placeholders
  variables INTEGER NOT NULL DEFAULT 0,     -- number of {{n}} body variables expected
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','disabled')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meta_template_name, language)
);
