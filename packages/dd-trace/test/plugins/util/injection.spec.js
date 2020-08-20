const { getHTMLComment } = require('../../../src/plugins/util/injection')

wrapIt()

describe('plugins/util/injection', () => {
  let tracer
  beforeEach(() => {
    tracer = require('../../../index')
    tracer.init()
    const now = Date.now()
    sinon.stub(Date, 'now').returns(now)
  })

  afterEach(() => {
    Date.now.restore()
  })

  it('injectRumData', () => {
    tracer.trace('injectRumData', () => {
      const data = tracer.injectRumData()
      const time = Date.now()
      const re = /<meta name="dd-trace-id" content="([\d\w]+)" \/><meta name="dd-trace-time" content="(\d+)" \/>/
      const [, traceId, traceTime] = re.exec(data)
      const span = tracer.scope().active().context()
      expect(span._manualHTMLInjection).to.equal(true)
      expect(traceId).to.equal(span._traceId.toString())
      expect(traceTime).to.equal(time.toString())
    })
  })

  it('getHTMLComment', () => {
    tracer.trace('getHTMLComment', () => {
      const comment = getHTMLComment(tracer)
      const time = Date.now()
      const re = /^<!-- DATADOG;trace-id=([\d\w]+);trace-time=(\d+) -->\n$/
      const [, traceId, traceTime] = re.exec(comment)
      expect(traceId).to.equal(tracer.scope().active().context()._traceId.toString())
      expect(traceTime).to.equal(time.toString())
    })
  })

  describe('auto injection', () => {
    it('works', (done) => {
      const http = require('http')
      let comment
      const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('done!')
        comment = res._ddHTMLComment
      })
      server.listen(() => {
        http.get(server.address(), (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.once('end', () => {
            expect(body).to.equal(`${comment}done!`)
            done()
          })
        }).end()
      })
    })
  })
})
