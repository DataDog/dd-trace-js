// Initializes the tracer with the application's own options before the other modules run.
import './tracer.mjs'

import http from 'node:http'

import { getRequestListener } from '@hono/node-server'
import { generateText } from 'ai'
import express from 'express'
import { Hono } from 'hono'

import model from './model.mjs'

const app = express()

app.get('/express', (req, res) => {
  res.json({ ok: true })
})

app.get('/http', (req, res) => {
  http.get(`http://127.0.0.1:${server.address().port}/express`, (response) => {
    response.resume()
    response.on('end', () => res.json({ status: response.statusCode }))
  })
})

app.get('/ai', async (req, res) => {
  const result = await generateText({ model, prompt: 'Say ok', experimental_telemetry: { isEnabled: true } })
  res.json({ text: result.text })
})

app.get('/langgraph', async (req, res) => {
  // Loaded on demand, so the bundler emits the graph and its dependencies as a separate chunk.
  const { runGraph } = await import('./graph.mjs')
  res.json(await runGraph())
})

// hono is an ES module package instrumented by hooks, so it is only traced when bundled if its exports are intercepted.
const hono = new Hono()
hono.get('/hono', context => context.json({ ok: true }))
const honoListener = getRequestListener(hono.fetch)

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/hono')) {
    honoListener(req, res)
  } else {
    app(req, res)
  }
})

server.listen(0, () => {
  process.send?.({ port: server.address().port })
})
