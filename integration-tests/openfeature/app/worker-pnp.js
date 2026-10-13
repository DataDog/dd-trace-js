'use strict'

const { createServer } = require('node:http')

globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
const Writer = require('dd-trace/packages/dd-trace/src/openfeature/writers/flag-evaluations')
let writer
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const [event] = JSON.parse(raw).flagEvaluations
    res.writeHead(202).end()
    writer.destroy()
    server.close()
    process.stdout.write(JSON.stringify({ pnp: Boolean(process.versions.pnp), event }))
  })
})
server.listen(0, '127.0.0.1', () => {
  const url = new URL('http://127.0.0.1:' + server.address().port)
  writer = new Writer({ url, service: 'pnp-worker-test' })
  writer.setEnabled(true, { url, basePath: '' })
  writer.enqueue({ flagKey: 'flag', timestamp: 100, targetingKey: 'private-pnp-target' })
  writer.flush()
})
