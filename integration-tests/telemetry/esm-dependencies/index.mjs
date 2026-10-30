import http from 'node:http'

// nanoid is ESM-only; axios also ships a CommonJS build, so keep it as an import:
// require('axios') is already reported.
import axios from 'axios'
import { nanoid } from 'nanoid'

const server = http.createServer((req, res) => {
  res.end(`${nanoid()} ${typeof axios.get}\n`)
}).listen(0, () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  process.send({ port })
})
