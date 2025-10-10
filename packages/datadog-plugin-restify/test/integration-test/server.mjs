import restify from 'restify'

const server = restify.createServer()

server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
