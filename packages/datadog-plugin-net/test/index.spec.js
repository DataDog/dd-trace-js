'use strict'

const getPort = require('get-port')
const dns = require('dns')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const { Int64BE } = require('int64-buffer') // TODO remove dependency
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

describe('Plugin', () => {
  let net
  let tcp
  let ipc
  let port
  let tracer
  let parent

  describe('net', () => {
    afterEach(() => {
      return agent.close()
    })

    afterEach(() => {
      tcp.close()
    })

    afterEach(() => {
      ipc.close()
    })

    beforeEach(() => {
      return agent.load('net')
        .then(() => {
          net = require(`net`)
          tracer = require('../../dd-trace')
          parent = tracer.startSpan('parent')
          parent.finish()

          return getPort()
        }).then(_port => {
          port = _port

          return new Promise(resolve => setImmediate(resolve))
        })
    })

    beforeEach(done => {
      tcp = new net.Server(socket => {
        socket.write('')
      })
      tcp.listen(port, () => done())
    })

    beforeEach(done => {
      ipc = new net.Server(socket => {
        socket.write('')
      })
      ipc.listen('/tmp/dd-trace.sock', () => done())
    })

    it('should instrument connect with a path', done => {
      expectSomeSpan(agent, {
        name: 'ipc.connect',
        service: 'test',
        resource: '/tmp/dd-trace.sock',
        meta: {
          'span.kind': 'client',
          'ipc.path': '/tmp/dd-trace.sock'
        },
        parent_id: new Int64BE(parent.context()._spanId._buffer)
      }).then(done).catch(done)

      tracer.scope().activate(parent, () => {
        net.connect('/tmp/dd-trace.sock')
      })
    })

    it('should instrument connect with a port', done => {
      const socket = new net.Socket()
      tracer.scope().activate(parent, () => {
        socket.connect(port, 'localhost')
        socket.on('connect', () => {
          expectSomeSpan(agent, {
            name: 'tcp.connect',
            service: 'test',
            resource: `localhost:${port}`,
            meta: {
              'span.kind': 'client',
              'tcp.family': 'IPv4',
              'tcp.remote.host': 'localhost',
              'tcp.local.address': socket.localAddress,
              'out.host': 'localhost'
            },
            metrics: {
              'out.port': port,
              'tcp.remote.port': port,
              'tcp.local.port': socket.localPort
            },
            parent_id: new Int64BE(parent.context()._spanId._buffer)
          }, 2000).then(done).catch(done)
        })
      })
    })

    it('should instrument connect with TCP options', done => {
      const socket = new net.Socket()
      tracer.scope().activate(parent, () => {
        socket.connect({
          port,
          host: 'localhost'
        })
        socket.on('connect', () => {
          expectSomeSpan(agent, {
            name: 'tcp.connect',
            service: 'test',
            resource: `localhost:${port}`,
            meta: {
              'span.kind': 'client',
              'tcp.family': 'IPv4',
              'tcp.remote.host': 'localhost',
              'tcp.local.address': socket.localAddress,
              'out.host': 'localhost'
            },
            metrics: {
              'out.port': port,
              'tcp.remote.port': port,
              'tcp.local.port': socket.localPort
            },
            parent_id: new Int64BE(parent.context()._spanId._buffer)
          }).then(done).catch(done)
        })
      })
    })

    it('should instrument connect with IPC options', done => {
      expectSomeSpan(agent, {
        name: 'ipc.connect',
        service: 'test',
        resource: '/tmp/dd-trace.sock',
        meta: {
          'span.kind': 'client',
          'ipc.path': '/tmp/dd-trace.sock'
        },
        parent_id: new Int64BE(parent.context()._spanId._buffer)
      }).then(done).catch(done)

      tracer.scope().activate(parent, () => {
        net.connect({
          path: '/tmp/dd-trace.sock'
        })
      })
    })

    it('should instrument error', done => {
      const socket = new net.Socket()

      let error = null

      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'tcp.connect',
            service: 'test',
            resource: `localhost:${port}`
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'tcp.family': 'IPv4',
            'tcp.remote.host': 'localhost',
            'out.host': 'localhost',
            [ERROR_TYPE]: error.name,
            [ERROR_MESSAGE]: error.message,
            [ERROR_STACK]: error.message
          })
          expect(traces[0][0].metrics).to.deep.include({
            'out.port': port,
            'tcp.remote.port': port
          })
          expect(traces[0][0].parent_id.toString()).to.equal(parent.context().toSpanId())
        })
        .then(done)
        .catch(done)

      tracer.scope().activate(parent, () => {
        tcp.close()
        socket.connect({ port })
        socket.once('error', (err) => {
          error = err
        })
      })
    })

    it('should cleanup event listeners when the socket changes state', done => {
      const socket = new net.Socket()

      tracer.scope().activate(parent, () => {
        const events = ['connect', 'error', 'close', 'timeout']

        socket.connect({ port })
        socket.destroy()

        socket.once('close', () => {
          expect(socket.eventNames()).to.not.include.members(events)
          done()
        })
      })
    })

    it('should run event listeners in the correct scope', () => {
      return tracer.scope().activate(parent, () => {
        const socket = new net.Socket()

        const promises = Array(5).fill(0).map(() => {
          let res
          let rej
          const p = new Promise((resolve, reject) => {
            res = resolve
            rej = reject
          })
          p.resolve = res
          p.reject = rej
          return p
        })

        socket.on('connect', () => {
          expect(tracer.scope().active()).to.equal(parent)
          promises[0].resolve()
        })

        socket.on('ready', () => {
          expect(tracer.scope().active()).to.equal(parent)
          socket.destroy()
          promises[1].resolve()
        })

        socket.on('close', () => {
          expect(tracer.scope().active()).to.not.be.null
          expect(tracer.scope().active().context()._name).to.equal('tcp.connect')
          promises[2].resolve()
        })

        socket.on('lookup', () => {
          expect(tracer.scope().active()).to.not.be.null
          expect(tracer.scope().active().context()._name).to.equal('tcp.connect')
          promises[3].resolve()
        })

        socket.connect({
          port,
          lookup: (...args) => {
            expect(tracer.scope().active()).to.not.be.null
            expect(tracer.scope().active().context()._name).to.equal('tcp.connect')
            promises[4].resolve()
            dns.lookup(...args)
          }
        })

        return Promise.all(promises)
      })
    })

    it('should run the connection callback in the correct scope', done => {
      const socket = new net.Socket()

      tracer.scope().activate(parent, () => {
        socket.connect({ port }, function () {
          expect(this).to.equal(socket)
          expect(tracer.scope().active()).to.equal(parent)
          socket.destroy()
          done()
        })
      })
    })
  })
})
