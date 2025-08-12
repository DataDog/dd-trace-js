const { PORT, HOSTNAME } = process.env

const { createServer } = require('http')
// eslint-disable-next-line n/no-deprecated-api
const { parse } = require('url')
const next = require('next')

const app = next({ dir: __dirname, dev: false, quiet: true, hostname: HOSTNAME, port: PORT })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)

    if (parsedUrl.path === '/exit') {
      server.close()
    } else {
      handle(req, res, parsedUrl)
    }
  }).listen(PORT, HOSTNAME, () => {
    console.log(server.address()) // eslint-disable-line no-console
  })
})
