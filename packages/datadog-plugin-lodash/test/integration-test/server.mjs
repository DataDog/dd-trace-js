import 'dd-trace/init.js'
import express from 'express'
import lodash from 'lodash'
import dc from 'dc-polyfill'

const lodashOperationCh = dc.channel('datadog:lodash:operation')
let counter = 0
lodashOperationCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  lodash.trim('  hello  ')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
