import tracer from 'dd-trace'

import { channel } from 'node:diagnostics_channel'

tracer.init({
  service: 'electron-integration-test',
  flushInterval: 0,
  plugins: false,
  experimental: { exporter: 'electron' },
})
tracer.use('electron', true)
tracer.use('ai', true)
tracer.use('hono', true)
// The hono server spans. Client requests are traced by the electron integration.
tracer.use('http', { client: false })

// Forward spans exported via the electron exporter to the test process via IPC.
channel('datadog:apm:electron:export').subscribe(traces => {
  process.send({ name: 'traces', payload: traces })
})
