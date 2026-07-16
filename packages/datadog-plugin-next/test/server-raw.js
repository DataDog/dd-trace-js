'use strict'

const { createServer } = require('node:http')
const dc = require('node:diagnostics_channel')

const next = require('next')

const { PORT, HOSTNAME } = process.env

// Activate the diagnostics-channel path the wrapper guards on without booting AppSec.
dc.channel('apm:next:query-parsed').subscribe(() => {})

const app = next({ dir: __dirname, dev: false, quiet: true, hostname: HOSTNAME, port: PORT })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res)
  }).listen(PORT, HOSTNAME, () => {
    console.log(server.address()) // eslint-disable-line no-console
  })
})
