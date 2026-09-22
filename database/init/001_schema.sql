CREATE SCHEMA IF NOT EXISTS n8n;
CREATE SCHEMA IF NOT EXISTS evolution;

CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  whatsapp_id TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  display_name TEXT,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN (
    'new', 'offered', 'awaiting_consent', 'sending_materials',
    'awaiting_payment', 'paid', 'stopped', 'failed'
  )),
  consented_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contact_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_followup_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contacts_state_idx ON contacts (state);
CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts (phone);

CREATE TABLE IF NOT EXISTS message_events (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL,
  content_summary TEXT,
  media_reference TEXT,
  event_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_events_contact_idx
  ON message_events (contact_id, event_at DESC);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  expected_amount NUMERIC(12, 2) NOT NULL CHECK (expected_amount > 0),
  confirmed_amount NUMERIC(12, 2) CHECK (confirmed_amount > 0),
  receipt_media_id TEXT,
  mercado_pago_payment_id TEXT,
  mercado_pago_preference_id TEXT,
  mercado_pago_payment_link TEXT,
  mercado_pago_payment_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  mercado_pago_status TEXT,
  mercado_pago_status_detail TEXT,
  mercado_pago_external_reference TEXT,
  mercado_pago_qr_code TEXT,
  mercado_pago_qr_code_base64 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'unpaid', 'cancelled')),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_one_pending_per_contact_idx
  ON sales (contact_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sales_status_created_idx ON sales (status, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_mercado_pago_payment_idx ON sales (mercado_pago_payment_id) WHERE mercado_pago_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS followups (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sequence_number SMALLINT NOT NULL CHECK (sequence_number BETWEEN 1 AND 7),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  processing_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS followups_due_idx
  ON followups (scheduled_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processing_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS sales_set_updated_at ON sales;
CREATE TRIGGER sales_set_updated_at
BEFORE UPDATE ON sales
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS app_config_set_updated_at ON app_config;
CREATE TRIGGER app_config_set_updated_at
BEFORE UPDATE ON app_config
FOR EACH ROW EXECUTE FUNCTION set_updated_at();



