import { createRequestHandler } from '@react-router/express'
import express from 'express'

const app = express()

app.use(express.static('build/client'))
app.all('*splat', createRequestHandler({ build: await import('./build/server/index.js') }))

const server = app.listen(0, () => {
  process.send?.({ port: server.address().port })
})
