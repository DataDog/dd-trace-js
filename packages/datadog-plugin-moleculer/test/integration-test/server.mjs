import 'dd-trace/init.js'
import moleculer from 'moleculer'

const broker = new moleculer.ServiceBroker({
  namespace: 'multi',
  nodeID: `server-${process.pid}`,
  logger: false,
  transporter: `tcp://127.0.0.1:0/server-${process.pid}`,
})

broker.createService({
  name: 'greeter',
  actions: {
    sayHello (ctx) {
      return 'Hello, ' + ctx.params.name
    },
  },
})

await broker.start()
await broker.call('greeter.sayHello', { name: 'test' })
await broker.stop()
