# Deployment on Contabo

## Expected environment
- Ubuntu 24.04
- Docker Engine + Docker Compose
- Traefik v3
- PostgreSQL
- domain/subdomain with DNS pointing to VPS
- ports 80/443 via Traefik

## Suggested services
```text
whatsapp-agent-web      Next.js admin
whatsapp-agent-api      Express API
whatsapp-agent-db       PostgreSQL (or existing managed container with isolated DB/user)
```
Optional later:
```text
whatsapp-agent-redis    only if queueing is justified
```

## Suggested domains
- `agent-client.example.com` admin
- `api-agent-client.example.com` API/webhook
Or one domain routed by path.

## Docker requirements
- restart policies
- health checks
- named persistent DB volume
- private backend network
- no database host port exposed to internet
- secrets via environment/secret mechanism

## Production checklist
1. DNS resolves
2. TLS valid
3. webhook verification succeeds
4. real inbound test message arrives
5. outgoing response succeeds
6. voice note downloads/transcribes
7. duplicate webhook test does not duplicate replies
8. AI pause works
9. human takeover works
10. logs contain no secrets
11. backup works
12. reboot/restart test succeeds
