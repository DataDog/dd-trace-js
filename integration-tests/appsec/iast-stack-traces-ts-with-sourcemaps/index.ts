import express from 'express'

import notRewrittenRoutes from './not-rewritten-routes'
import rewrittenRoutes from './rewritten-routes'

const app = express()

app.use('/not-rewritten', notRewrittenRoutes)
app.use('/rewritten', rewrittenRoutes)

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (/** @type {import('net').AddressInfo} */ (server.address())).port })
})
