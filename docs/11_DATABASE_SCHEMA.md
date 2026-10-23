# Database Schema

Suggested PostgreSQL entities.

## users
- id
- name
- phone/email/login identifier
- password_hash or auth provider ID
- role
- active
- created_at/updated_at

## customers
- id
- whatsapp_user_id / phone
- display_name
- preferred_language
- company_name optional
- metadata jsonb
- created_at/updated_at

## conversations
- id
- customer_id
- channel (`whatsapp`)
- mode (`AI`,`HUMAN_PENDING`,`HUMAN`,`PAUSED`)
- current_summary
- opened_at
- last_message_at
- assigned_user_id nullable

## messages
- id
- conversation_id
- whatsapp_message_id unique nullable
- direction (`IN`,`OUT`)
- sender_type (`CUSTOMER`,`AI`,`HUMAN`,`SYSTEM`)
- message_type (`TEXT`,`AUDIO`,`IMAGE`,`DOCUMENT`,`SYSTEM`)
- text
- transcription nullable
- media_meta jsonb
- raw_payload_ref/jsonb as policy allows
- processing_status
- model_name nullable
- created_at

## webhook_events
- id
- provider
- event_key/message_id unique where possible
- payload jsonb
- received_at
- processed_at
- status
- error

## knowledge_articles
- id
- title
- content
- category
- active
- version
- created_by/updated_by
- timestamps

## vocabulary
- id
- term
- alternates jsonb
- language
- meaning
- examples jsonb
- active
- timestamps

## agent_settings
- id
- key/value or structured columns
- updated_by
- updated_at

## handoffs
- id
- conversation_id
- reason
- status
- requested_at
- accepted_by
- accepted_at
- returned_to_ai_at

## tool_executions
- id
- conversation_id
- message_id
- tool_name
- request jsonb
- response jsonb
- status
- duration_ms
- created_at

## audit_logs
Immutable application-level history:
- id
- actor_id/type
- action
- entity_type/entity_id
- old_value jsonb
- new_value jsonb
- source
- timestamp
