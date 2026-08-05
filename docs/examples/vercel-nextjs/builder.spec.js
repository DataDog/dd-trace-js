'use strict'

const assert = require('node:assert')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  getInstrumentationPaths,
  instrumentBuildOutput,
  prepareBuildInput,
} = require('./builder')

class FileBlob {
  constructor ({ data }) {
    this.data = data
  }
}

function file (data) {
  return new FileBlob({ data })
}

describe('Vercel Next Builder prototype', () => {
  it('adds an instrumentation entrypoint before the Next build without changing dependencies', () => {
    const options = {
      entrypoint: 'package.json',
      files: { 'package.json': file('{"name":"app","dependencies":{"dd-trace":"7.0.0"}}') },
    }
    const packageFile = options.files['package.json']

    prepareBuildInput(options, FileBlob)

    assert.strictEqual(options.files['package.json'], packageFile)
    assert.strictEqual(options.files['instrumentation.ts'].data, "import 'dd-trace/initialize.mjs'\n")
  })

  it('refuses to overwrite root or src instrumentation files', () => {
    for (const instrumentationPath of getInstrumentationPaths('.')) {
      const options = {
        entrypoint: 'package.json',
        files: {
          'package.json': file('{"name":"app"}'),
          [instrumentationPath]: file('export function register () {}\n'),
        },
      }
      const existingFile = options.files[instrumentationPath]

      assert.throws(
        () => prepareBuildInput(options, FileBlob),
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

      const nodeConfig = JSON.parse(await fs.readFile(path.join(nodeFunction, '.vc-config.json'), 'utf8'))
      assert.strictEqual(
        nodeConfig.environment.NODE_OPTIONS,
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
})
