'use strict'

const path = require('path')
const getDiClient = require('../../../../src/ci-visibility/dynamic-instrumentation')
const getConfig = require('../../../../src/config')
const sum = require('./di-dependency')

// keep process alive
const intervalId = setInterval(() => {}, 5000)

const diClient = getDiClient(getConfig())

diClient.start()

diClient.worker.on('exit', (exitCode) => {
  process.send({ exitCode })
})

diClient.isReady().then(async () => {
  // No script is loaded from this file, so setting the probe fails
  const [, failedSetPromise] = diClient.addLineProbe({ file: path.join(__dirname, 'not-loaded.js'), line: 1 }, () => {})
  await failedSetPromise

  const [, setPromise] = diClient.addLineProbe(
    { file: path.join(__dirname, 'di-dependency.js'), line: 10 },
    ({ snapshot }) => {
      process.send({ snapshot })
      clearInterval(intervalId)
    }
  )
  await setPromise
  sum(1, 2)
})
