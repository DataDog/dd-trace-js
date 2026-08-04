import './init.mjs'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

app.get('/', context => context.text('ok'))

serve({ port: 0, fetch: app.fetch }, info => {
  process.send({ port: info.port })
})
