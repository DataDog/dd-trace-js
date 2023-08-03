import 'dd-trace/init.js'
import os from 'os'
import Gateway from 'microgateway-core'
import getPort from 'get-port'

const port = await getPort()
const gateway = Gateway({
  edgemicro: {
    port: port,
    logging: { level: 'info', dir: os.tmpdir() }
  },
  proxies: []
})

gateway.start(() => {
  process.send({ port })
})
