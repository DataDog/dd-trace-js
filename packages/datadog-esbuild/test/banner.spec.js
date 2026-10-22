'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { sandboxCwd, useSandbox } = require('../../../integration-tests/helpers')
const ddPlugin = require('../index')

/**
 * @param {string} code
 * @param {vm.Context} [context]
 */
function record (code, context = vm.createContext({})) {
  const banner = code.split('\n').find(line => line.startsWith('((r,b)=>'))
  if (banner) {
    // ESM output keeps the startup code as a banner line; the rest of the file cannot run as a script.
    vm.runInContext(banner, context)
  } else {
    // CommonJS and IIFE output inject it as a bundled module, so it only runs with the bundle.
    const runBundle = vm.runInContext(`(function (require, module, exports) {${code}\n})`, context)
    runBundle(require, { exports: {} }, {})
  }
  return JSON.parse(vm.runInContext('JSON.stringify(globalThis[Symbol.for("dd-trace:bundler")])', context))
}

describe('esbuild bundler banner', () => {
  let directory
  let esbuild

  useSandbox([`esbuild@${process.env.ESBUILD_VERSION || 'latest'}`], false, [])

  before(() => {
    esbuild = require(require.resolve('esbuild', { paths: [sandboxCwd()] }))
  })

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-esbuild-banner-'))
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  /** @param {Record<string, unknown>} options */
  function build (options = {}) {
    return esbuild.build({
      stdin: { contents: 'require("node:http");' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(directory, 'out.cjs'),
      plugins: [ddPlugin],
      logLevel: 'silent',
      ...options,
    })
  }

  for (const write of [true, false]) {
    it(`marks the bundle with write=${write} without forcing a metafile`, async () => {
      const result = await build({ write })
      const code = write
        ? await fs.readFile(path.join(directory, 'out.cjs'), 'utf8')
        : result.outputFiles[0].text

      assert.deepEqual(record(code), { bundlers: ['esbuild'] })
      assert.equal(result.metafile, undefined)
    })
  }

  it('marks a build written to stdout', () => {
    const source = `
      const esbuild = require(${JSON.stringify(require.resolve('esbuild', { paths: [sandboxCwd()] }))});
      const plugin = require(${JSON.stringify(require.resolve('../index'))});
      esbuild.build({
        stdin: { contents: 'require("node:http");' },
        bundle: true,
        platform: 'node',
        plugins: [plugin],
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `
    const code = execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8' })
    assert.deepEqual(record(code), { bundlers: ['esbuild'] })
  })

  for (const format of ['cjs', 'iife']) {
    it(`keeps a ${format} bundle in strict mode`, async () => {
      const result = await build({
        format,
        stdin: { contents: "'use strict'\nglobalThis.strict = (function () { return this })() === undefined" },
        write: false,
      })
      const code = result.outputFiles[0].text
      const context = vm.createContext({})

      assert.deepEqual(record(code, context), { bundlers: ['esbuild'] })
      assert.equal(context.strict, true)
    })
  }

  it('preserves user banners', async () => {
    const userBanner = 'globalThis.userBanner = true;'
    const result = await build({ banner: { js: userBanner }, write: false })
    const code = result.outputFiles[0].text

    assert.ok(code.includes(userBanner))
    record(code)
  })

  it('marks every output when entries share chunks', async () => {
    await fs.writeFile(path.join(directory, 'shared.js'), 'export const shared = 1;')
    for (const name of ['one', 'two']) {
      await fs.writeFile(path.join(directory, `${name}.mjs`), `
        import { shared } from './shared.js';
        console.log(shared);
      `)
    }
    const result = await build({
      stdin: undefined,
      entryPoints: ['one.mjs', 'two.mjs'].map(name => path.join(directory, name)),
      outfile: undefined,
      outdir: path.join(directory, 'out'),
      outExtension: { '.js': '.mjs' },
      format: 'esm',
      splitting: true,
      write: false,
    })

    assert.ok(result.outputFiles.some(file => path.basename(file.path).startsWith('chunk-')))
    for (const file of result.outputFiles) {
      assert.deepEqual(record(file.text).bundlers, ['esbuild'])
    }
  })

  for (const platform of ['browser', 'neutral']) {
    it(`warns instead of throwing for platform=${platform}`, async () => {
      const result = await build({ platform, stdin: { contents: 'console.log("ok");' }, write: false })
      assert.ok(result.warnings.some(warning => warning.text.includes('platform') && warning.text.includes('node')))
      assert.ok(result.outputFiles[0].text.includes('ok'))
    })
  }

  it('reports failed builds unchanged', async () => {
    await assert.rejects(build({ stdin: { contents: 'syntax error !!!' } }), /Unexpected|Expected/)
  })
})
