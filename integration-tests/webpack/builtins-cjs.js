#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

require('../..').init()

const { createServer, request } = require('node:http')
const { lookup } = require('node:dns')
const assert = require('node:assert/strict')
const dc = require('dc-polyfill')

const counts = { client: 0, server: 0, dns: 0 }
dc.subscribe('apm:http:client:request:start', ctx => {
  if (ctx.args.options.path === '/builtin-regression') counts.client++
})
dc.subscribe('apm:http:server:request:start', ctx => {
  if (ctx.req.url === '/builtin-regression') counts.server++
})
dc.subscribe('apm:dns:lookup:start', ctx => {
  if (ctx.args[0] === 'localhost') counts.dns++
})

const sourceMapMarker = 'WEBPACK_BUILTIN_SOURCE_MAP_MARKER'
if (sourceMapMarker.length === 0) throw new Error('source map marker unavailable')

/**
 * @param {typeof import('node:http').request} requestFunction
 * @param {number} port
 */
async function requestWith (requestFunction, port) {
  await new Promise((resolve, reject) => {
    const req = requestFunction({ hostname: '127.0.0.1', port, path: '/builtin-regression', agent: false }, res => {
      res.resume()
      res.once('end', resolve)
    })
    req.once('error', reject)
    req.end()
  })
}

async function main () {
  await new Promise((resolve, reject) => {
    lookup('localhost', error => error ? reject(error) : resolve())
  })

  const server = createServer((_req, res) => res.end('ok'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  await requestWith(request, server.address().port)

  const { request: dynamicRequest } = await import('node:http')
  await requestWith(dynamicRequest, server.address().port)

  await new Promise(resolve => server.close(resolve))
  assert.deepStrictEqual(counts, { client: 2, server: 2, dns: 1 })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
