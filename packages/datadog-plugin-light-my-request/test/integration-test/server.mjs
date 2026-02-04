import 'dd-trace/init.js'
import inject from 'light-my-request'
import dc from 'dc-polyfill'

const startServerCh = dc.channel('apm:http:server:request:start')

let counter = 0
startServerCh.subscribe(() => {
  counter += 1
})

const dispatch = function (req, res) {
  const reply = JSON.stringify({ counter })
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': reply.length
  })
  res.end(reply)
}

inject(dispatch, { method: 'GET', url: '/' }, (err, res) => {
  if (err) {
    process.exit(1)
  }
  process.exit(0)
})
