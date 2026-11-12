import 'dd-trace/init.js'
import express from 'express'

const app = express()

// Early Express 4 versions expose a throwing getter for the removed JSON middleware.
const json = Object.getOwnPropertyDescriptor(express, 'json')?.value
if (typeof app.query === 'function' && typeof json === 'function') {
  const router = express.Router()
  router.query('/reports/:id', json(), function handleQuery (req, res) {
    res.json({ id: req.params.id, filter: req.body.filter })
  })
  app.use('/api', router)
}

app.use((req, res) => {
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
