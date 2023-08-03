import 'dd-trace/init.js'
import Koa from 'koa'

const app = new Koa()

app.use(async (ctx) => {
  ctx.body = 'hello, world\n'
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
