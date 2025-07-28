import 'dd-trace/init.js'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'

const app = new Hono()

app.get('/hello', (c) => {
  return c.text('green energy\n')
})

serve({
  fetch: app.fetch,
}, (i) => {
  const port = i.port
  process.send({ port })
})
