'use strict'

const path = require('node:path')

const { sandboxCwd, useSandbox } = require('../helpers')
const { assertAppTraces, build, fixtureDependencies, formats, supportsNode } = require('./helpers')

const viteVersion = process.env.VITE_PLUGIN_TEST_VERSION || 'latest'

describe(`Vite plugin with Vite ${viteVersion}`, function () {
  this.timeout(180_000)

  useSandbox([`vite@${viteVersion}`, ...fixtureDependencies], false, [path.join(__dirname, 'plugin')])

  before(function () {
    if (!supportsNode(['vite'])) {
      // Older Node.js release lines may not meet Vite's engine requirements.
      this.skip()
    }
  })

  for (const [format, extension] of Object.entries(formats)) {
    it(`traces CJS, ESM and Orchestrion targets in ${extension} output`, async () => {
      const cwd = path.join(sandboxCwd(), 'plugin')
      build(cwd, 'vite', format)
      await assertAppTraces(path.join(cwd, `dist-${format}`, `server.${extension}`))
    })
  }
})
