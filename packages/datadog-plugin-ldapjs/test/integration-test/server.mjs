import 'dd-trace/init.js'
import express from 'express'
import ldapjs from 'ldapjs'
import dc from 'dc-polyfill'

const ldapSearchCh = dc.channel('datadog:ldapjs:client:search')
let counter = 0
ldapSearchCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  const client = ldapjs.createClient({ url: 'ldap://127.0.0.1:389' })
  client.search('dc=example', 'cn=test', () => {})
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
