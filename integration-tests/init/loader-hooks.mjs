import http from 'node:http'
import dc from 'dc-polyfill'

let instrumented = false
dc.subscribe('apm:http:client:request:start', () => {
  instrumented = true
})

const server = http.createServer((req, res) => {
  res.end('Hello World')
}).listen(0, () => {
  http.get(`http://localhost:${(/** @type {import('net').AddressInfo} */ (server.address())).port}`, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      server.close()
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ instrumented, ...globalThis._ddLoaderHookCalls }))
      process.exit()
    })
  })
})
