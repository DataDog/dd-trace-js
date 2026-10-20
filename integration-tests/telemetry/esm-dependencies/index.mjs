import http from 'node:http'

// Both packages are ESM-only ("type": "module") and have no dd-trace instrumentation,
// so the loader never wraps them.
import axios from 'axios'
import { nanoid } from 'nanoid'

const server = http.createServer((req, res) => {
  res.end(`${nanoid()} ${typeof axios.get}\n`)
}).listen(0, () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  process.send({ port })
})
