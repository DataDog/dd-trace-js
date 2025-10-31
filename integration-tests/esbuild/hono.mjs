import './init.mjs'

import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'

import { serve } from '@hono/node-server'

const app = new Hono()

function loggerMiddleware () {
  return createMiddleware(async (c, next) => {
    await next()
  })
}

app.use(loggerMiddleware())

app.get('/', (c) => c.text('Kaixo'))

serve({ port: 0, fetch: app.fetch }, (info) => {
  process.send({ port: info.port })
})
