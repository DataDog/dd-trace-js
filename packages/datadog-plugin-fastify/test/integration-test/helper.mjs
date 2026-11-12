export async function createAndStartServer (app) {
  app.get('/', async (request, reply) => {
    return 'hello, world\n'
  })

  try {
    await app.listen({ port: 0 })
    const address = app.server.address()
    const port = address.port
    process.send({ port })
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exit(1)
  }
}
