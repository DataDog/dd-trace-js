'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const { sandboxCwd, useSandbox } = require('./helpers')

const execFileAsync = promisify(execFile)

describe('sandbox fixture copies', () => {
  const directory = path.join(os.tmpdir(), `dd-trace-sandbox-${randomUUID()}`)
  const first = path.join(directory, 'first')
  const second = path.join(directory, 'second')

  before(() => {
    for (const source of [first, second]) {
      fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(source, 'shared.txt'), source)
      fs.writeFileSync(path.join(source, 'nested', 'shared.txt'), source)
    }
    fs.writeFileSync(path.join(first, 'first-only.txt'), first)
    fs.writeFileSync(path.join(second, 'second-only.txt'), second)
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(first, `${String(i).padStart(3, '0')}.txt`), first)
    }
  })

  after(() => fs.rmSync(directory, { recursive: true, force: true }))

  for (const scenario of [
    { name: 'empty sources', sources: [], expected: {}, absent: ['shared.txt'] },
    {
      name: 'one source',
      sources: [path.join(first, '*')],
      expected: { 'shared.txt': first, 'nested/shared.txt': first, 'first-only.txt': first },
      absent: ['second-only.txt'],
    },
    {
      name: 'disjoint sources',
      sources: [path.join(first, 'first-only.txt'), path.join(second, 'second-only.txt')],
      expected: { 'first-only.txt': first, 'second-only.txt': second },
      absent: ['shared.txt'],
    },
    {
      name: 'overlapping sources',
      sources: [path.join(first, '*'), path.join(second, '*')],
      expected: {
        'shared.txt': second,
        'nested/shared.txt': second,
        'first-only.txt': first,
        'second-only.txt': second,
      },
      absent: [],
    },
  ]) {
    describe(scenario.name, () => {
      useSandbox([], false, scenario.sources)

      it('applies sources in order', () => {
        const folder = sandboxCwd()
        for (const filename of scenario.absent) {
          assert.strictEqual(fs.existsSync(path.join(folder, filename)), false)
        }
        for (const [filename, contents] of Object.entries(scenario.expected)) {
          assert.strictEqual(fs.readFileSync(path.join(folder, filename), 'utf8'), contents)
        }
        assert.strictEqual(fs.existsSync(path.join(folder, 'node_modules', 'dd-trace', 'package.json')), true)
      })
    })
  }

  describe('failed source', () => {
    it('rejects without copying later sources', async () => {
      const temporary = path.join(directory, 'failed')
      fs.mkdirSync(temporary)
      const spec = path.join(directory, 'failed.spec.cjs')
      fs.writeFileSync(spec, `
'use strict'
const { useSandbox } = require(${JSON.stringify(path.join(__dirname, 'helpers'))})
describe('failed source', () => {
  useSandbox([], false, ${JSON.stringify([path.join(directory, 'missing-fixtures'), path.join(second, '*')])})
  it('does not run', () => {})
})
`)
      await assert.rejects(execFileAsync(process.execPath, [
        require.resolve('mocha/bin/mocha.js'), '--no-config', '--no-package', '--reporter', 'json', spec,
      ], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      }), { code: 1, stdout: /missing-fixtures/ })

      const roots = fs.readdirSync(temporary, { withFileTypes: true }).filter(entry => entry.isDirectory())
      assert.strictEqual(roots.length, 1)
      const root = path.join(temporary, roots[0].name)
      const folders = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
      assert.strictEqual(folders.length, 1)
      assert.strictEqual(fs.existsSync(path.join(root, folders[0].name, 'second-only.txt')), false)
    })
  })
})
