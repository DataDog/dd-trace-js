'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const net = require('node:net')
const path = require('node:path')

const finish = require('../finish')

// Bun resolves `postgres` to its ESM build through the `bun` export condition, so load the CommonJS build directly.
const postgres = require(path.join(__dirname, '..', '..', 'node_modules', 'postgres', 'cjs', 'src', 'index.js'))

// Connecting to a closed port still runs the query lifecycle, which ends with a connection error.
const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())

  server.close(async () => {
    const sql = postgres({ host: '127.0.0.1', port, connect_timeout: 1, max_lifetime: 1 })

    await sql`select 1`.catch(() => {})
    await sql.end({ timeout: 0 })

    finish()
  })
})
