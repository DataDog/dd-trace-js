import 'dd-trace/init.js'
import express from 'express'
import { Sequelize } from 'sequelize'
import dc from 'dc-polyfill'

const startCh = dc.channel('datadog:sequelize:query:start')
let counter = 0

startCh.subscribe(() => {
  counter += 1
})

const app = express()

const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })

app.get('/', async (req, res) => {
  await sequelize.query('SELECT 1 AS result')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
