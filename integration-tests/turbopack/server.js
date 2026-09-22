'use strict'

const { createServer } = require('node:http')

const next = require('next')

const nextApp = next({ dev: false })
const handle = nextApp.getRequestHandler()

async function start () {
  await nextApp.prepare()

  const server = createServer((request, response) => handle(request, response))
  server.listen(0, () => {
    const port = server.address().port
    process.send({ port })
  })
}

start()
