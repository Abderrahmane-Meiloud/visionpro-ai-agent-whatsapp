# Knowledge Base and Hassaniya Customization

## Data categories
### Static knowledge
Good candidates:
- company description
- office hours
- delivery areas
- return/support policy
- FAQ
- service explanations
- contact/escalation rules

### Dynamic data
Must come from tools/database when changing frequently:
- prices
- inventory
- order status
- balances
- delivery assignments
- current promotions
- customer-specific terms

## V1 storage
Use PostgreSQL tables for approved knowledge articles, FAQs, vocabulary, and examples. Do not add a vector DB just because this is an AI project.

## Later RAG trigger
Add embeddings/vector retrieval only when the knowledge corpus becomes large enough that sending/retrieving structured knowledge becomes inefficient (for example, many long manuals/catalogs/PDFs).

## Vocabulary record
Each entry should support:
- canonical term
- alternate spellings
- language/dialect
- meaning
- category
- example sentences
- product/entity link if relevant
- active flag

## Example
```json
{
  "term": "كرطونة",
  "alternates": ["كرتونة"],
  "language": "hassaniya",
  "meaning": "carton/case",
  "examples": ["عندكم عشر كرطونات من المنتج؟"]
}
```

## Client editing
Authorized admins can add/edit/archive knowledge and vocabulary. All changes require audit history: who, when, previous value, new value.

## Uploaded files
V1 may support PDF, DOCX, TXT, CSV, XLSX ingestion. Never treat an uploaded price list as permanently authoritative if prices are expected to change; convert dynamic data to structured records/tools.
