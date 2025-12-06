import './init.mjs'

import express from 'express'

import iastRouter from './iast/index.mjs'

const app = express()

app.use('/iast', iastRouter)

const server = app.listen(0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
