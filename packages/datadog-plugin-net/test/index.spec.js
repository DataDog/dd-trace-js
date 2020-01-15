'use strict'

const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

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
      return agent.load(plugin, 'net')
        .then(() => {
          net = require(`net`)
          tracer = require('../../dd-trace')
          parent = tracer.startSpan('parent')
          parent.finish()

          return getPort().then(_port => {
            port = _port
          })
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
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'ipc.connect',
            service: 'test-ipc',
            resource: '/tmp/dd-trace.sock'
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'ipc.path': '/tmp/dd-trace.sock'
          })
          expect(traces[0][0].parent_id.toString()).to.equal(parent.context().toSpanId())
        })
        .then(done)
        .catch(done)

      tracer.scope().activate(parent, () => {
        net.connect('/tmp/dd-trace.sock')
      })
    })

    it('should instrument connect with a port', done => {
      const socket = new net.Socket()

      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'tcp.connect',
            service: 'test-tcp',
            resource: `localhost:${port}`
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'tcp.family': 'IPv4',
            'tcp.remote.host': 'localhost',
            'tcp.local.address': '127.0.0.1',
            'out.host': 'localhost'
          })
          expect(traces[0][0].metrics).to.deep.include({
            'out.port': port,
            'tcp.remote.port': port,
            'tcp.local.port': socket.localPort
          })
          expect(traces[0][0].parent_id.toString()).to.equal(parent.context().toSpanId())
        })
        .then(done)
        .catch(done)

      tracer.scope().activate(parent, () => {
        socket.connect(port, 'localhost')
      })
    })

    it('should instrument connect with TCP options', done => {
      const socket = new net.Socket()

      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'tcp.connect',
            service: 'test-tcp',
            resource: `localhost:${port}`
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'tcp.family': 'IPv4',
            'tcp.remote.host': 'localhost',
            'tcp.local.address': '127.0.0.1',
            'out.host': 'localhost'
          })
          expect(traces[0][0].metrics).to.deep.include({
            'out.port': port,
            'tcp.remote.port': port,
            'tcp.local.port': socket.localPort
          })
          expect(traces[0][0].parent_id.toString()).to.equal(parent.context().toSpanId())
        })
        .then(done)
        .catch(done)

      tracer.scope().activate(parent, () => {
        socket.connect({
          port,
          host: 'localhost'
        })
      })
    })

    it('should instrument connect with IPC options', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'ipc.connect',
            service: 'test-ipc',
            resource: '/tmp/dd-trace.sock'
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'ipc.path': '/tmp/dd-trace.sock'
          })
          expect(traces[0][0].parent_id.toString()).to.equal(parent.context().toSpanId())
        })
        .then(done)
        .catch(done)

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
            service: 'test-tcp',
            resource: `localhost:${port}`
          })
          expect(traces[0][0].meta).to.deep.include({
            'span.kind': 'client',
            'tcp.family': 'IPv4',
            'tcp.remote.host': 'localhost',
            'out.host': 'localhost',
            'error.type': error.name,
            'error.msg': error.message,
            'error.stack': error.stack
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

    it('should run event listeners in the correct scope', done => {
      const socket = new net.Socket()

      tracer.scope().activate(parent, () => {
        socket.once('close', () => {
          expect(tracer.scope().active()).to.equal(parent)
          done()
        })
      })

      socket.connect({ port })
      socket.destroy()
    })
  })
})
