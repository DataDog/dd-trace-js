import container from 'rhea'

container.on('connection_open', function (context) {
  context.connection.open_receiver('amq.topic')
  context.connection.open_sender('amq.topic')
})
container.on('message', function (context) {
  context.connection.close()
})
container.on('sendable', function (context) {
  context.sender.send({ body: 'Hello World!' })
  context.sender.detach()
})

container.connect({
  username: 'admin',
  password: 'admin',
  host: 'localhost',
  port: 5673
})
