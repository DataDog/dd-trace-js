import { createServer } from 'http'
import next from 'next'

const nextApp = next({ dev: true })
const handle = nextApp.getRequestHandler()

nextApp.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res)
  }).listen(0, () => {
    const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
    process.send({ port })
  })
})
