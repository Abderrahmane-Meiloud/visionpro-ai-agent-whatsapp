# Internal API Endpoints

## Public webhook
- `GET /webhooks/meta/whatsapp` — Meta verification
- `POST /webhooks/meta/whatsapp` — incoming events

## Admin auth
Use existing VisionPro AI Agent preferred simple login approach only if appropriate for this internal tool; production authentication must still be secure. Never expose admin without authentication.

## Admin APIs
- `GET /api/conversations`
- `GET /api/conversations/:id`
- `POST /api/conversations/:id/takeover`
- `POST /api/conversations/:id/return-to-ai`
- `POST /api/conversations/:id/messages`
- CRUD `/api/knowledge`
- CRUD `/api/vocabulary`
- `GET/PATCH /api/agent-settings`
- `POST /api/agent/pause`
- `POST /api/agent/resume`
- `GET /api/health`
- `GET /api/logs` with role restrictions

## Internal provider interfaces
```ts
interface TextAIProvider {
  generate(input: AgentInput): Promise<AgentResult>
}

interface TranscriptionProvider {
  transcribe(audio: Buffer, context: TranscriptionContext): Promise<TranscriptResult>
}

interface RealtimeVoiceProvider {
  // Phase 2 only
  createSession(config: VoiceSessionConfig): Promise<RealtimeSession>
}

interface WhatsAppProvider {
  sendText(...): Promise<SendResult>
  getMedia(...): Promise<MediaResult>
  markRead?(...): Promise<void>
}
```
