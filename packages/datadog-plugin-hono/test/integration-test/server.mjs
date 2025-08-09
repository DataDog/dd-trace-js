import 'dd-trace/init.js'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'

import process from 'node:process'

const app = new Hono()

const version = process.env.VERSION.split('.').map(Number)

const hasCombine = version[0] > 4 || version[0] === 4 && version[1] >= 5
const response = 'green energy\n'

if (hasCombine) {
  const { every } = await import('hono/combine')
  app.use(every(async (context, next) => {
    context.set('response', response)
    return next()
  }))
} else {
  app.use(async (context, next) => {
    context.set('response', response)
    return next()
  })
}

app.get('/hello', (c) => {
  const res = c.get('response')
  if (res !== response) {
    throw new Error(`Expected response to be "${response}", got "${res}"`)
  }
  return c.text(res)
})

serve({
  fetch: app.fetch,
}, (i) => {
  const port = i.port
  process.send({ port })
})
