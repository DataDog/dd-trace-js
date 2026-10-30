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

// Forward spans exported via the electron exporter to the test process via IPC.
channel('datadog:apm:electron:export').subscribe(traces => {
  process.send({ name: 'traces', payload: traces })
})
