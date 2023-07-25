import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import { ServiceBroker } from 'moleculer'
import getPort from 'get-port'

pluginHelpers.onMessage(async () => {
  const port = await getPort()

  const broker = new ServiceBroker({
    namespace: 'multi',
    nodeID: `server-${process.pid}`,
    logger: false,
    transporter: `tcp://127.0.0.1:${port}/server-${process.pid}`
  })

  broker.createService({
    name: 'greeter',
    actions: {
      sayHello (ctx) {
        return 'Hello, ' + ctx.params.name
      }
    }
  })

  await broker.start()
  await broker.call('greeter.sayHello', { name: 'test' })
  await broker.stop()
})
