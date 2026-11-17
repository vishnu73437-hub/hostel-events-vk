# EventHub migration checks

Run:

```sh
npm test
python tests/schema.test.py
```

The Node tests cover VK launch signature verification. The Python/SQLite checks validate the D1 schema's table set, per-event registration isolation, legacy identity separation, duplicate checkpoint protection, and proof-storage slot constraints. These are local schema/unit checks, not a live Cloudflare/VK end-to-end test.
