import './init.mjs'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

/**
 * @param {import('hono').Context} context
 */
function handleRequest (context) {
  return context.text('ok')
}

/**
 * @param {{ port: number }} info
 */
function announceServer (info) {
  process.send({ port: info.port })
}

app.get('/', handleRequest)
serve({ port: 0, fetch: app.fetch }, announceServer)
