# EventHub migration checks

Run:

```sh
npm test
python tests/schema.test.py
```

The Node tests cover VK launch signature verification, the admin backup endpoint, the Apps Script receiver's syntax and mocked runtime behavior, the exact 34-column guest register order, formula-injection protection, event-log idempotency, stale-snapshot handling, and stable guest identity across pending/approved/event-log updates. The Python/SQLite checks validate the D1 schema, event isolation, checkpoint uniqueness, proof-storage constraints, and offline backup/restore generation. These remain local/unit checks, not a live Cloudflare/VK/Google end-to-end test.
