'use strict'

const { PORT, WITH_CONFIG } = process.env

require('../../..').init({
  service: 'test',
  flushInterval: 0,
  plugins: false
}).use('next', WITH_CONFIG ? {
  validateStatus: code => false,
  hooks: {
    request: (span) => {
      span.setTag('foo', 'bar')
    }
  }
} : true)

const { createServer } = require('http')
const { parse } = require('url')
const next = require('next') // eslint-disable-line import/no-extraneous-dependencies

const app = next({ dir: __dirname, dev: false, quiet: true })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)

    if (parsedUrl.path === '/exit') {
      server.close()
    } else {
      handle(req, res, parsedUrl)
    }
  }).listen(PORT, 'localhost', () => {
    console.log(server.address()) // eslint-disable-line no-console
  })
})
