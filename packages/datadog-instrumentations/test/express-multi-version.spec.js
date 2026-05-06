'use strict'

const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const axios = require('axios')
const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

const express4Dir = join(__dirname, '..', '..', '..', 'versions', 'express@4')
const express5Dir = join(__dirname, '..', '..', '..', 'versions', 'express@>=5.0.0')

const describeOrSkip = existsSync(express4Dir) && existsSync(express5Dir)
  ? describe
  : describe.skip

// Express 4 ships path-to-regexp 0.1.x; express 5 ships 8.x. Each is loaded
// once in this process; the wrappers must capture the dialect that was
// current when the host's addHook fired so the second load doesn't
// retroactively swap the first.
describeOrSkip('express path-to-regexp dialect across versions', () => {
  const enterEvents = []

  const captureExpress = ({ route }) => enterEvents.push({ kind: 'express', route })
  const captureRouter = ({ route }) => enterEvents.push({ kind: 'router', route })

  let express4
  let express5
  let appListeners

  before(() => agent.load(['express', 'router', 'http'], { client: false }))

  before(() => {
    express5 = require(express5Dir).get()
    express4 = require(express4Dir).get()

    dc.channel('apm:express:middleware:enter').subscribe(captureExpress)
    dc.channel('apm:router:middleware:enter').subscribe(captureRouter)
  })

  after(() => {
    dc.channel('apm:express:middleware:enter').unsubscribe(captureExpress)
    dc.channel('apm:router:middleware:enter').unsubscribe(captureRouter)
    return agent.close({ ritmReset: false })
  })

  beforeEach(() => {
    enterEvents.length = 0
    appListeners = []
  })

  afterEach(() => {
    for (const listener of appListeners) {
      listener.close()
    }
  })

  /**
   * @param {import('http').Server} listener
   * @returns {Promise<number>} The bound port.
   */
  function listenOn (listener) {
    appListeners.push(listener)
    return new Promise(resolve => listener.once('listening', () => resolve(listener.address().port)))
  }

  it('isolates each version\'s dialect when both are loaded in the same process', async () => {
    // `/*splat` is express-5 syntax. path-to-regexp 8.x compiles it to a
    // regex that matches anything; 0.1.x compiles it to a regex that
    // requires the URL to end in the literal "splat". A successful tag on
    // the express-5 app proves its wrapper kept the 8.x compile, even
    // though express 4 (and its 0.1.x) was loaded into the same process.
    const app5 = express5()
    app5.use(['/api/users', '/*splat'], (req, res) => res.end())

    // The express-4 app uses a multi-pattern array of plain paths (which
    // both dialects accept) so this side stays a sanity check rather than
    // a dialect-specific assertion.
    const app4 = express4()
    app4.use(['/users', '/products'], (req, res) => res.end())

    const [port5, port4] = await Promise.all([
      listenOn(app5.listen(0, 'localhost')),
      listenOn(app4.listen(0, 'localhost')),
    ])

    await Promise.all([
      axios.get(`http://localhost:${port5}/anything/here`),
      axios.get(`http://localhost:${port4}/users`),
    ])

    const fromExpress5 = enterEvents.filter(e => e.kind === 'router')
    const fromExpress4 = enterEvents.filter(e => e.kind === 'express')

    assert.ok(
      fromExpress5.some(e => e.route === '/*splat'),
      `express 5 should match /*splat via 8.x; events from router=${JSON.stringify(fromExpress5)}`,
    )
    assert.ok(
      fromExpress4.some(e => e.route === '/users'),
      `express 4 should match /users via 0.1.x; events from express=${JSON.stringify(fromExpress4)}`,
    )
  })
})
