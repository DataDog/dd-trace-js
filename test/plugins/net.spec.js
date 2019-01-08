'use strict'

const getPort = require('get-port')
const agent = require('./agent')
const plugin = require('../../src/plugins/net')

wrapIt()

describe('Plugin', () => {
  let net
  let tcp
  let ipc
  let port

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
            name: 'net.connect',
            service: 'test-net',
            resource: '/tmp/dd-trace.sock',
            meta: {
              'span.kind': 'client',
              'socket.type': 'ipc',
              'socket.path': '/tmp/dd-trace.sock'
            }
          })
        })
        .then(done)
        .catch(done)

      net.connect('/tmp/dd-trace.sock')
    })

    it('should instrument connect with a port', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'net.connect',
            service: 'test-net',
            resource: `localhost:${port}`,
            meta: {
              'span.kind': 'client',
              'socket.type': 'tcp',
              'socket.port': `${port}`,
              'socket.hostname': 'localhost'
            }
          })
        })
        .then(done)
        .catch(done)

      net.connect(port, 'localhost')
    })

    it('should instrument connect with TCP options', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'net.connect',
            service: 'test-net',
            resource: `localhost:${port}`,
            meta: {
              'span.kind': 'client',
              'socket.type': 'tcp',
              'socket.port': `${port}`,
              'socket.hostname': 'localhost'
            }
          })
        })
        .then(done)
        .catch(done)

      net.connect({
        port,
        host: 'localhost'
      })
    })

    it('should instrument connect with IPC options', done => {
      agent
        .use(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'net.connect',
            service: 'test-net',
            resource: '/tmp/dd-trace.sock',
            meta: {
              'span.kind': 'client',
              'socket.type': 'ipc',
              'socket.path': '/tmp/dd-trace.sock'
            }
          })
        })
        .then(done)
        .catch(done)

      net.connect({
        path: '/tmp/dd-trace.sock'
      })
    })
  })
})
