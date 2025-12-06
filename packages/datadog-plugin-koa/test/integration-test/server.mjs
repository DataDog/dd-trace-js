import 'dd-trace/init.js'
import Koa from 'koa'

const app = new Koa()

app.use(async (ctx) => {
  ctx.body = 'hello, world\n'
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
