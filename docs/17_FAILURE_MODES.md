# Failure Modes and Required Behavior

## Meta unavailable / send fails
- retry safely with bounded exponential backoff
- never create duplicate customer-visible messages where idempotency can prevent it
- record failure for operator

## AI provider unavailable
- one controlled retry/fallback model if configured
- otherwise send a short safe fallback or handoff

## STT fails
- ask customer to repeat/type
- do not hallucinate transcript

## Tool/database fails
- never fabricate result
- tell customer it cannot be confirmed now
- hand off if important

## Model returns unsafe/invalid output
- validate response before send
- strip accidental internal metadata
- do not send system prompts/tool JSON

## Human takeover race
- check conversation mode immediately before send; discard AI output if mode changed

## Cost runaway
- rate/length limits
- cap maximum context size
- summarize old conversation history
- monitor tokens/minutes by conversation
- alert on abnormal usage

## Infinite loops/tool loops
- max tool-call count per turn
- max retries
- deterministic error exit to human
