import Koa from 'koa'
import Router from '@koa/router'

const app = new Koa()

const fooRouter = new Router()

fooRouter.get('/foo', (ctx) => {
  ctx.body = 'foo'
})

app.use(fooRouter.routes())

app.listen(3000)
