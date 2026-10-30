// Initializes the tracer with the application's own options before the other modules run.
import './tracer.mjs'

import http from 'node:http'

import { generateText } from 'ai'
import express from 'express'

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

const server = app.listen(0, () => {
  process.send?.({ port: server.address().port })
})
