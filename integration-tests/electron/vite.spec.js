'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { sandboxCwd, useSandbox } = require('../helpers')
const { assertAppTraces, build, fixtureDependencies, formats, supportsNode } = require('../vite/helpers')

describe('Vite plugin in the Electron main process', function () {
  this.timeout(180_000)

  useSandbox(['electron', 'electron-vite', 'vite', ...fixtureDependencies], false, [
    path.join(__dirname, 'vite-app'),
    path.join(__dirname, '../vite/plugin'),
  ])

  before(function () {
    if (!supportsNode(['electron-vite', 'vite'])) {
      // Older Node.js release lines may not meet electron-vite's or Vite's engine requirements.
      this.skip()
    }
  })

  for (const tracer of ['external', 'bundled']) {
    for (const [format, extension] of Object.entries(formats)) {
      it(`traces CJS, ESM and Orchestrion targets in ${extension} output with dd-trace ${tracer}`, async () => {
        const cwd = path.join(sandboxCwd(), 'vite-app')
        const electron = require(path.join(sandboxCwd(), 'node_modules/electron'))
        build(cwd, 'electron-vite', format, { VITE_TRACER: tracer })

        const output = path.join(cwd, 'out/main')
        // Run the bundled build away from the sandbox so it cannot fall back to its node_modules.
        const standalone = tracer === 'bundled' ? await fs.mkdtemp(path.join(os.tmpdir(), 'dd-trace-electron-')) : null
        const runDir = standalone ?? output
        try {
          if (standalone) await fs.cp(output, standalone, { recursive: true })
          await assertAppTraces(path.join(runDir, `index.${extension}`), {
            cwd: runDir,
            execPath: electron,
            execArgv: process.platform === 'linux' ? ['--no-sandbox'] : [],
          })
        } finally {
          if (standalone) await fs.rm(standalone, { recursive: true, force: true })
        }
      })
    }
  }
})
