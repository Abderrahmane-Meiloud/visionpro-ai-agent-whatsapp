# Architecture

## V1 message flow

```text
Customer WhatsApp
      |
      v
Meta WhatsApp Cloud API
      |
      v HTTPS webhook
Traefik -> Express API
      |
      +--> validate + deduplicate + persist
      |
      +--> text ---------------------------+
      |                                    |
      +--> audio -> media download -> STT -+--> Agent Core
                                               |
                              +----------------+----------------+
                              |                |                |
                          Knowledge        Business Tools   Conversation State
                              |                |                |
                              +----------------+----------------+
                                               |
                                               v
                                         Safety/Authority
                                               |
                               +---------------+---------------+
                               |                               |
                           AI response                    Human handoff
                               |                               |
                               v                               v
                      Meta /messages API                 Dashboard queue
                               |
                               v
                            Customer
```

## Later live-call flow

```text
WhatsApp call
   -> official Meta Calling API/media transport
   -> RealtimeVoiceProvider adapter
   -> Gemini Live OR OpenAI Realtime
   -> same Agent Core tools/policies/customer context
   -> streaming audio back to WhatsApp
```

## Service boundaries
- `whatsapp`: Meta Cloud API, webhook parsing, media, outgoing messages
- `agent`: prompt construction, language/style rules, tool calling, response policy
- `transcription`: voice-note STT provider adapter
- `voice`: future realtime provider adapter
- `knowledge`: static knowledge retrieval
- `tools`: authoritative business operations/data lookups
- `conversations`: history, summaries, modes, handoff
- `admin`: configuration and operator UI

## Do not over-engineer V1
No Kafka, no microservices, no vector DB by default. One backend service plus PostgreSQL is enough. Add Redis/BullMQ only if load, long-running jobs, or webhook response deadlines require it.
