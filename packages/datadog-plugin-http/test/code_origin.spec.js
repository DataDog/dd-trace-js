'use strict'

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  describe('http', () => {
    describe('Code Origin for Spans', () => {
      before(() => {
        // Needed when this spec file run together with other spec files, in which case the agent config is not
        // re-loaded unless the existing agent is wiped first. And we need the agent config to be re-loaded in order to
        // enable Code Origin for Spans.
        agent.wipe()
      })

      beforeEach(async () => {
        return agent.load(
          'http',
          { server: false },
          { codeOriginForSpans: { experimental: { exit_spans: { enabled: true } } } }
        )
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should add code_origin tags for outbound requests', done => {
        server((port) => {
          const http = require('http')

          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span.meta).to.have.property('_dd.code_origin.type', 'exit')

              // Just validate that frame 0 tags are present. The detailed validation is performed in a different test.
              expect(span.meta).to.have.property('_dd.code_origin.frames.0.file')
              expect(span.meta).to.have.property('_dd.code_origin.frames.0.line')
              expect(span.meta).to.have.property('_dd.code_origin.frames.0.column')
              expect(span.meta).to.have.property('_dd.code_origin.frames.0.method')
              expect(span.meta).to.have.property('_dd.code_origin.frames.0.type')
            })
            .then(done)
            .catch(done)

          const req = http.request(`http://localhost:${port}/`, res => {
            res.resume()
          })

          req.end()
        })
      })
    })
  })
})

function server (callback) {
  const http = require('http')

  const server = http.createServer((req, res) => {
    res.end()
  })

  server.listen(() => {
    callback(server.address().port)
  })
}
