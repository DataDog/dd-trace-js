import 'dd-trace/init.js'
import express from 'express'
import { runInThisContext } from 'node:vm'
import dc from 'dc-polyfill'

const runScriptCh = dc.channel('datadog:vm:run-script:start')
let counter = 0
runScriptCh.subscribe(() => {
  counter += 1
})

const app = express()

let localVar = 'initial value'

app.get('/', (req, res) => {
  localVar = runInThisContext('localVar = "anotherValue";')
  res.setHeader('X-Counter', counter)
  res.end(`ok ${localVar}`)
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
