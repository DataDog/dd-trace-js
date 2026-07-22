'use strict'

const tracer = require('dd-trace')

const { once } = require('node:events')
const http = require('node:http')

const { OpenFeature } = require('@openfeature/server-sdk')

const {
  TEST_DEFAULT_VALUE,
  TEST_FLAG_KEY,
  TEST_SERVICE,
  TEST_TARGETING_KEY,
} = process.env

tracer.init({
  env: 'integration',
  flushInterval: 0,
  service: TEST_SERVICE,
})

let client

/**
 * @param {object} message
 * @param {'access'|'evaluate'|'trace'} message.command
 * @param {string} [message.spanName]
 * @param {string} [message.url]
 * @param {boolean} [message.waitForReady]
 */
async function handleMessage (message) {
  try {
    if (message.command === 'access') {
      const provider = tracer.openfeature
      if (message.waitForReady) {
        await OpenFeature.setProviderAndWait(provider)
      } else {
        OpenFeature.setProvider(provider)
      }
      client = OpenFeature.getClient()
      send({ accessed: true })
      return
    }

    if (message.command === 'evaluate') {
      const details = await client.getStringDetails(TEST_FLAG_KEY, TEST_DEFAULT_VALUE, {
        targetingKey: TEST_TARGETING_KEY,
        userId: TEST_TARGETING_KEY,
      })
      send({ details })
      return
    }

    if (message.command === 'trace') {
      await tracer.trace(message.spanName, async () => {
        if (message.url) {
          const request = http.get(message.url)
          const [response] = await once(request, 'response')
          response.resume()
          await once(response, 'end')
        }
      })
      send({ traced: true })
    }
  } catch (error) {
    send({ error: error.stack || error.message })
  }
}

/**
 * @param {object} message
 */
function send (message) {
  process.send?.({ port: 0, ...message })
}

process.on('message', handleMessage)
send({ ready: true })
