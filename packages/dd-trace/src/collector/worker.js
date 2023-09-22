const { parentPort, workerData } = require('node:worker_threads')
const { submit } = require('./native')

const { host } = workerData

parentPort.on('message', data => {
  submit(data, host)
})
