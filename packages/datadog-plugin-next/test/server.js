'use strict'

const { once } = require('node:events')
const { createServer } = require('node:http')
const { URL } = require('node:url')
const { takeCoverage } = require('node:v8')

const next = require('next')

const tracer = require('../../..')

const { PORT, HOSTNAME } = process.env

async function main () {
  const server = createServer((req, res) => {
    const base = `http://${req.headers.host || 'localhost'}`
    const url = new URL(req.url || '/', base)

    if (url.pathname === '/exit') {
      server.close()
    } else {
      if (req.headers['x-test-close-response'] === 'true') res.destroy()
      const upstreamRoute = req.headers['x-test-upstream-route']
      if (typeof upstreamRoute === 'string') {
        tracer.scope().active()?.addTags({
          'http.route': upstreamRoute,
          'resource.name': `GET ${upstreamRoute}`,
        })
      }

      handle(req, res, {
        pathname: url.pathname,
        path: url.pathname + url.search,
        query: Object.fromEntries(url.searchParams),
        search: url.search,
      })
    }
  }).listen(PORT, HOSTNAME)
  await once(server, 'listening')

  const app = next({ dir: __dirname, dev: false, quiet: true, hostname: HOSTNAME, port: server.address().port })
  const handle = app.getRequestHandler()
  await app.prepare()
  if (process.env.NODE_V8_COVERAGE && process.listenerCount('SIGTERM') === 0) {
    process.once('SIGTERM', () => {
      takeCoverage()
      process.kill(process.pid, 'SIGTERM')
    })
  }
  console.log(server.address()) // eslint-disable-line no-console
}

main()
