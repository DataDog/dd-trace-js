'use strict'

const { PORT } = process.env

require('./datadog')

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
