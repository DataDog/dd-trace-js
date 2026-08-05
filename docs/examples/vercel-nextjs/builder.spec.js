'use strict'

const assert = require('node:assert')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const {
  getInstrumentationPaths,
  hasFrozenInstallCommand,
  instrumentBuildOutput,
  prepareBuildInput,
} = require('./builder')

class FileBlob {
  constructor ({ data }) {
    this.data = data
  }

  toStream () {
    return Readable.from(this.data)
  }
}

function file (data) {
  return new FileBlob({ data })
}

function getFileData (file) {
  return JSON.parse(file.data)
}

describe('Vercel Next Builder prototype', () => {
  it('adds an instrumentation entrypoint and production tracer dependency before the Next build', async () => {
    const options = {
      entrypoint: 'package.json',
      files: { 'package.json': file('{"name":"app"}') },
    }

    await prepareBuildInput(options, '7.0.0', FileBlob)

    assert.deepStrictEqual(getFileData(options.files['package.json']), {
      name: 'app',
      dependencies: { 'dd-trace': '7.0.0' },
    })
    assert.strictEqual(options.files['instrumentation.ts'].data, `export function register () {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    require('dd-trace/init')
  }
}
`)
  })

  it('moves an existing development tracer dependency to production dependencies', async () => {
    const options = {
      entrypoint: 'apps/web/package.json',
      files: {
        'apps/web/package.json': file('{"devDependencies":{"dd-trace":"6.0.0","typescript":"5.0.0"}}'),
      },
    }

    await prepareBuildInput(options, '7.0.0', FileBlob)

    assert.deepStrictEqual(getFileData(options.files['apps/web/package.json']), {
      dependencies: { 'dd-trace': '6.0.0' },
      devDependencies: { typescript: '5.0.0' },
    })
    assert.ok(options.files['apps/web/instrumentation.ts'])
  })

  it('refuses to overwrite root or src instrumentation files', async () => {
    for (const instrumentationPath of getInstrumentationPaths('.')) {
      const options = {
        entrypoint: 'package.json',
        files: {
          'package.json': file('{"name":"app"}'),
          [instrumentationPath]: file('export function register () {}\n'),
        },
      }
      const existingFile = options.files[instrumentationPath]

      await assert.rejects(
        prepareBuildInput(options, '7.0.0', FileBlob),
        new RegExp(`Cannot add Datadog instrumentation because ${instrumentationPath} already exists`)
      )
      assert.strictEqual(options.files[instrumentationPath], existingFile)
    }
  })

  it('adds the preload only to generated Node function configuration', async () => {
    const outputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-vercel-output-'))
    const nodeFunction = path.join(outputPath, 'functions', 'api.func')
    const edgeFunction = path.join(outputPath, 'functions', 'edge.func')

    try {
      await fs.mkdir(nodeFunction, { recursive: true })
      await fs.mkdir(edgeFunction, { recursive: true })
      await fs.writeFile(path.join(nodeFunction, '.vc-config.json'), JSON.stringify({
        environment: { NODE_OPTIONS: '--enable-source-maps' },
        runtime: 'nodejs22.x',
      }))
      await fs.writeFile(path.join(edgeFunction, '.vc-config.json'), JSON.stringify({ runtime: 'edge' }))

      await instrumentBuildOutput(outputPath)

      assert.strictEqual(
        JSON.parse(await fs.readFile(path.join(nodeFunction, '.vc-config.json'), 'utf8')).environment.NODE_OPTIONS,
        '--import=dd-trace/initialize.mjs --enable-source-maps'
      )
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(path.join(edgeFunction, '.vc-config.json'), 'utf8')),
        { runtime: 'edge' }
      )
    } finally {
      await fs.rm(outputPath, { force: true, recursive: true })
    }
  })

  it('requires a direct dependency before a frozen install', async () => {
    const options = {
      config: { installCommand: 'npm ci' },
      entrypoint: 'package.json',
      files: { 'package.json': file('{"name":"app"}') },
    }

    assert.strictEqual(hasFrozenInstallCommand(options.config.installCommand), true)
    await assert.rejects(
      prepareBuildInput(options, '7.0.0', FileBlob),
      /Add dd-trace to production dependencies and update the lockfile/
    )
  })
})
