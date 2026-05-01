'use strict'

// Wrapper for test:plugins:ci that strips all OTEL_* env vars before running
// nyc. OTEL vars injected by CI observability tooling would otherwise cause
// DatadogTracer to select OtlpHttpTraceExporter instead of AgentExporter,
// sending spans to an external endpoint rather than the mock agent.
const { spawnSync } = require('child_process')
const path = require('path')

const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('OTEL_')) {
    env[key] = value
  }
}

const nyc = path.join(__dirname, '..', 'node_modules', '.bin', 'nyc')
const result = spawnSync(nyc, process.argv.slice(2), { env, stdio: 'inherit' })

process.exit(result.status ?? 1)
