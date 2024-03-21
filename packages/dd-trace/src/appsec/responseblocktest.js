// TODO: turn me into integration tests please

const tracer = require('../../../../').init({
  appsec: true
})
const http = require('http')
const fs = require('fs')

/*
if long polling then we need to block early no ?
if we block too soon, APM traces don't make sense anymore :/

potentially useful stuff:
  res.on('prefinish')
  res.writableEnded
  res[kOutHeaders]
  res.headersSent
  res.getHeaders()
  res._writeRaw()
*/

const handlers = {
  continue (req, res) {
    res.writeContinue()
    res.end('end')
  },
  processing (req, res) {
    res.writeProcessing()
    res.end('end')
  },
  earlyHints (req, res) {
    res.writeEarlyHints({ 'link': '</styles.css>; rel=preload; as=style' });
    res.end('end')
  },
  statusCode (req, res) {
    res.statusCode = 300
    res.end('end')
  },
  setHeader (req, res) {
    res.setHeaders(new Map(Object.entries({ a: 1, b: 2 })))
    res.setHeader('k', 'v')
    res.writeHead(200, ['test', 'aaa'])
    res.end()
  },
  writeHead (req, res) {
    res.writeHead(200, 'OK', { writeHead: 'writeHeadValue' })
    res.end('end')
  },
  flushHeaders (req, res) {
    res.flushHeaders()
    res.end('end')
  },
  write (req, res) {
    res.write('write')
    res.end('end')
  },
  stream (req, res) {
    const stream = fs.createReadStream(__dirname + '/file', { encoding: 'utf8' })
    stream.pipe(res, { end: false })
    stream.on('end', () => res.end('end'))
  },
  addTrailers (req, res) {
    res.addTrailers({ 'k': 'v' })
    res.end()
  },
  end (req, res) {
    res.end('end')
  },
  everything (req, res) {
    // do all of the above
    res.writeContinue()
    res.writeProcessing()
    res.writeEarlyHints({ 'link': '</styles.css>; rel=preload; as=style' });
    res.setHeader('k', 'v')
    res.writeHead(200, 'OK', { writeHead: 'writeHeadValue' })
    res.flushHeaders()
    res.write('write')
    handlers.stream(req, res)
    res.addTrailers({ 'k': 'v' })
  }
}

http.createServer((req, res) => {
  const handler = handlers[req.url.slice(1)]

  if (handler) {
    handler(req, res)
  } else {
    res.end('notfound')
  }
}).listen(1337)

async function main () {
  for (const name of Object.keys(handlers)) {
    const res = await request('http://localhost:1337/' + name)
    if (res.statusCode !== 403) console.log(name, res.statusCode, res.statusMessage, res.headers, res.body)
  }

  //process.exit()
}

//main()

function request (url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''

      res.on('error', reject)
      res.on('data', (data) => body += data.toString('utf8'))
      res.on('end', () => {
        res.body = body
        resolve(res)
      })
    })
  })
}
