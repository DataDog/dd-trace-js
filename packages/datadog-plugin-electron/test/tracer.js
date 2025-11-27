'use strict'

const port = process.env.DD_TRACE_AGENT_PORT

require('../../dd-trace')
  .init({
    service: 'test',
    env: 'tester',
    port,
    flushInterval: 0,
    plugins: false
  })
  .use('electron', true)
  .setUrl(`http://127.0.0.1:${port}`)
