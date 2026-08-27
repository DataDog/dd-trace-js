import { createServer } from 'node:http'
import next from 'next'

const nextApp = next({ dev: false })
const handle = nextApp.getRequestHandler()

await nextApp.prepare()

const server = createServer((req, res) => handle(req, res))
server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
