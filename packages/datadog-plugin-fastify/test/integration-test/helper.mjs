export async function createAndStartServer (app) {
  app.get('/', async (request, reply) => {
    return 'hello, world\n'
  })

  const startServer = async () => {
    try {
      await app.listen(0)
      const address = app.server.address()
      const port = address.port
      process.send({ port })
    } catch (err) {
      process.exit(1)
    }
  }
  startServer()
  return startServer
}