import 'dd-trace/init.js'
import os from 'os'
import Gateway from 'microgateway-core'

const gateway = Gateway({
  edgemicro: {
    port: 0,
    logging: { level: 'info', dir: os.tmpdir() }
  },
  proxies: []
})

gateway.start((err, server) => {
  const { port } = server.address()
  process.send({ port })
})
