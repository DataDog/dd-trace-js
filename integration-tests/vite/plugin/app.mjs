import http from 'node:http'

import { getRequestListener } from '@hono/node-server'
import express from 'express'
import { buildSchema, graphql } from 'graphql'
import { Hono } from 'hono'

export function startServer () {
  const schema = buildSchema('type Query { hello: String }')
  const app = express()
  app.get('/graphql', async (req, res) => {
    res.json(await graphql({ schema, source: '{ hello }', rootValue: { hello: 'ok' } }))
  })

  const hono = new Hono()
  hono.get('/hono', context => context.json({ hello: 'ok' }))
  const honoListener = getRequestListener(hono.fetch)

  const server = http.createServer((req, res) => {
    if (req.url === '/hono') return honoListener(req, res)
    app(req, res)
  })
  server.listen(0, () => {
    process.send({ port: server.address().port })
  })
}
