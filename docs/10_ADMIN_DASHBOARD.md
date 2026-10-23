# Admin Dashboard

## V1 pages
1. Dashboard
2. Conversations
3. Human handoffs
4. Knowledge
5. Vocabulary
6. Products/data sources (optional in first test)
7. Agent settings
8. Logs/health
9. Users/roles

## Dashboard metrics
- messages today
- AI-handled conversations
- human handoffs
- failed messages
- failed transcriptions
- average first-response time

## Agent settings
- AI enabled toggle
- text enabled
- voice notes enabled
- supported languages
- default text model
- transcription model
- max response length
- handoff conditions
- business hours behavior

## Critical control
Global **PAUSE AI** button. It must take effect before new outbound AI replies.

## Roles
- Owner/Admin: everything
- Manager: conversations, knowledge, settings as granted
- Agent/Staff: conversations/handoffs only

## Editing rule
Authorized edit/correct/delete/archive actions need confirmation where destructive and immutable audit history showing who changed what, when, and old/new values.
