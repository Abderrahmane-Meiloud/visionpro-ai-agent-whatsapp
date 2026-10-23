# Source of Truth and Freshness Rules

## External APIs change
The coding agent must verify current official documentation when implementing:
- Meta Graph API version
- webhook signature verification
- WABA subscriptions
- media endpoints
- message templates/customer-service window
- WhatsApp Calling API eligibility and realtime media transport
- OpenAI exact model IDs/endpoints
- Gemini exact Live model IDs/endpoints

## Do not trust stale snippets
Examples in old blog posts, Stack Overflow answers, or old Postman snippets may use deprecated Graph versions. Prefer Meta's current official documentation/workspace.

## Business data freshness
Each business field should have one source of truth:
- static FAQ -> approved knowledge
- price -> price tool/database
- stock -> inventory tool/database
- customer balance -> accounting/customer tool
- negotiation floor -> backend rule

The LLM is never the source of truth for mutable business facts.
