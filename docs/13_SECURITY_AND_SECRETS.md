# Security and Secrets

## Required environment variables
See `.env.example`.

## Rules
- Never commit `.env`.
- Never store Facebook/Meta login passwords.
- Use a production system-user/permanent Meta token rather than a temporary developer token.
- Keep App Secret private.
- Rotate compromised secrets.
- Verify webhook authenticity using Meta's current official signature procedure.
- Restrict admin routes with authentication + authorization.
- Apply rate limits to public endpoints where appropriate.
- Validate all webhook payloads and tool parameters.
- Treat customer messages and uploaded files as untrusted input.
- Sanitize filenames/content; limit upload sizes/types.
- Encrypt connections with HTTPS.
- Database not exposed publicly.
- Log secret-safe metadata only; redact tokens, authorization headers, and sensitive payloads.

## Data minimization
Store only what the business actually needs. Raw voice notes should be temporary by default. Configure message/data retention with the client.

## Backups
Use existing VisionPro AI Agent backup strategy (e.g. encrypted/controlled backups to object storage) and test restoration.
