'use strict'

const { channel } = require('node:diagnostics_channel')

// dd-trace is bundled inside the binary alongside the app source.
// No external path or NODE_OPTIONS injection needed.
require('dd-trace').init({
  service: 'electron-integration-test',
  flushInterval: 0,
  plugins: false,
  experimental: { exporter: 'electron' },
}).use('electron', true)

// Forward spans exported via the electron exporter to the test process via IPC.
channel('datadog:apm:electron:export').subscribe(traces => {
  process.send({ name: 'traces', payload: traces })
})
