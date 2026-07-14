import 'dd-trace/init.js'
import http from 'node:http'
import { toNodeHandler } from 'h3'
import { createNitroApp } from './node_modules/nitro/dist/runtime/virtual/app.mjs'

const nitroApp = createNitroApp()
const server = http.createServer(toNodeHandler(nitroApp.h3))

server.listen(0, () => {
  process.send({ port: server.address().port })
})
