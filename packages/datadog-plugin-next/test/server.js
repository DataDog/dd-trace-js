'use strict'

const { createServer } = require('node:http')
const { URL } = require('node:url')

const next = require('next')

const tracer = require('../../..')

const { PORT, HOSTNAME } = process.env

const app = next({ dir: __dirname, dev: false, quiet: true, hostname: HOSTNAME, port: PORT })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const base = `http://${req.headers.host || 'localhost'}`
    const url = new URL(req.url || '/', base)

    if (url.pathname === '/exit') {
      server.close()
    } else {
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
  }).listen(PORT, HOSTNAME, () => {
    console.log(server.address()) // eslint-disable-line no-console
  })
})
