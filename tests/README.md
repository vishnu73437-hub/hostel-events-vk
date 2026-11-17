# EventHub checks

Run the dependency-free VK launch authentication tests with:

```sh
npm test
```

These tests cover valid signatures, tampering, stale launch parameters, app-ID mismatch, and missing signatures. They do not replace end-to-end tests against a real VK Mini App or a provisioned D1 database.
