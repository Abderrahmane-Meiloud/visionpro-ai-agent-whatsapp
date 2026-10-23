# Product Scope

## V1 — Must build now
The agent connects to one real WhatsApp Business number and automatically handles:
- Incoming text messages
- Incoming voice notes
- Hassaniya Arabic
- French
- Hassaniya/French code-switching
- Modern Standard Arabic when used
- English when used
- Conversation history
- Company FAQ/knowledge
- Editable Hassaniya/company vocabulary
- Business tools for dynamic facts
- Human handoff
- AI pause/resume
- Message logs and processing status
- Basic customer profiles

## V1 — Response style
- Match the customer's language naturally.
- Hassaniya is preferred when the customer writes/speaks Hassaniya.
- French is used when the customer uses French.
- If the customer mixes languages, the agent may mix naturally rather than forcing one language.
- English should be handled normally when used.
- Do not over-formalize Hassaniya into MSA unless the customer does.
- Be concise like a real WhatsApp representative.

## V1 — Out of scope
- Live WhatsApp calls (document architecture now; implement in Phase 2)
- Normal cellular/PSTN phone calls
- Mass marketing automation
- Unofficial WhatsApp automation
- Autonomous unrestricted discounting
- Payment handling
- Full CRM/ERP replacement
- Training a shared model on client conversations
- Multi-tenant SaaS architecture

## V2 / later
- Official WhatsApp Calling API
- Real-time Hassaniya voice
- Voice response to voice notes
- Deeper CRM/ERP tools
- Quotations/order creation where policy allows
- Approval workflows for negotiation
- Analytics and QA scoring
- Optional RAG/vector search when document volume justifies it

## Success definition
A real customer can message or send a voice note to the business's WhatsApp number, receive a useful answer within seconds, and be handed to a human when the system cannot safely answer.
