Measures agent trace encoding with pre-built HTTP-service traces. The fixtures
include Express, Postgres, Redis, HTTP-client, DNS, and error spans. Each
operation updates request-specific fields while it keeps common span data
stable. The immediate-flush workload uses a ten-span API request and
`flushInterval: 0`, then assembles one payload per trace before a no-op send.
