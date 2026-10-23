# Text Message Workflow

## Inbound processing
1. Meta sends webhook POST.
2. Verify request authenticity according to current Meta webhook guidance.
3. Parse WABA/phone/message metadata.
4. Immediately record raw event and unique WhatsApp message ID.
5. If message ID was already processed, return success and do nothing else.
6. Identify or create customer by WhatsApp identifier/phone.
7. Identify conversation.
8. If conversation mode is HUMAN, persist message but do not invoke AI.
9. Normalize text.
10. Run agent with customer/context/knowledge/tools.
11. Persist agent decision, tool calls, and response.
12. Send response through official Meta `/messages` API.
13. Record Meta response/message ID and later delivery status updates.

## Rapid multi-message handling
Customers often send:
- "سلام"
- then "عندي سؤال"
- then "على الطلبية"
within a few seconds.

Implement a short configurable debounce window (for example 1-3 seconds) before invoking AI so adjacent messages can be combined where appropriate. Do not delay every message excessively.

## Supported message types in V1
- text: process
- audio/voice: transcribe then process
- image/document: store metadata and politely handoff or use optional processing only if explicitly enabled
- unsupported type: explain briefly or hand off

## Outbound messages
Use official Cloud API only. Store every outgoing WhatsApp message ID for status tracking.

## Business-initiated messages
Do not assume arbitrary proactive messaging is allowed. Respect Meta's current customer-service window and approved template requirements. The coding agent must fetch/confirm current rules before implementing proactive outbound flows.
