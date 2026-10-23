# Business Tools and Actions

## Principle
The LLM interprets intent and language. The backend remains the authority for business data and permissions.

## Initial tool interface
Implement typed server-side tools such as:
- `get_customer_by_phone(phone)`
- `get_company_info(topic)`
- `search_approved_knowledge(query)`
- `get_product(product_ref)`
- `get_product_price(product_id, customer_id?, quantity?)`
- `check_stock(product_id)`
- `get_order_status(order_ref, customer_id)`
- `get_customer_balance(customer_id)` (only if client enables it)
- `create_support_ticket(customer_id, reason, summary)`
- `request_human_handoff(conversation_id, reason)`
- `get_negotiation_authority(product_id, customer_id, quantity)`
- `request_discount_approval(...)`

For the first test, stub or omit tools that the client does not actually have data for.

## Tool contract
Every tool returns machine-readable status:
```json
{
  "ok": true,
  "data": {},
  "error_code": null,
  "safe_user_message": null
}
```

The model must not translate a failed tool call into a successful business claim.

## Negotiation authority example
```json
{
  "list_price": 10000,
  "minimum_ai_price": 9700,
  "minimum_manager_price": 9500,
  "requires_approval_below": 9700
}
```

## Audit
All state-changing actions must record:
- actor (AI/human/system)
- user/customer
- conversation
- timestamp
- old value/new value when applicable
- source message
- result
