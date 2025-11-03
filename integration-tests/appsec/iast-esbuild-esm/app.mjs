import './init.mjs'

import express from 'express'

import iastRouter from './iast/index.mjs'

// eslint-disable-next-line
import randomJson from './random.json' with { type: 'json' }

const app = express()

app.use('/iast', iastRouter)

const server = app.listen(0, () => {
  process.send?.({ port: server.address().port })
})
