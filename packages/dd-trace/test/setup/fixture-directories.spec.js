'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const sinon = require('sinon')

const { FixtureDirectories, FIXTURE_ROOT_ENV } = require('./helpers/fixture-directories')

const checkout = path.resolve(__dirname, '../../../..')
const setup = path.join(__dirname, 'mocha.js')
const helper = path.join(__dirname, 'helpers/fixture-directories.js')
const cli = path.join(checkout, 'node_modules/mocha/bin/mocha.js')
const custom = path.join(checkout, 'scripts/mocha-run-file.js')

// Fixture runners use the installed harness Mocha, not the versioned package under test.
// Global fixtures require Mocha >=8.2.0 in both release lines.
describe('fixture directory lifetime', () => {
  let directories
  let source

  beforeEach(() => {
    directories = new FixtureDirectories()
    source = directories.createRunRoot()
    fs.writeFileSync(path.join(source, 'source.js'), 'fixture')
    fs.mkdirSync(path.join(source, '.next'))
    fs.writeFileSync(path.join(source, '.next', 'generated'), 'not a source')
  })

  afterEach(async () => {
    sinon.restore()
    await directories.cleanup()
  })

  it('allocates distinct run and version directories and copies only named sources', () => {
    const first = directories.createRunRoot()
    const second = directories.createRunRoot()
    const one = directories.createFixture(first, 'next', source, ['source.js'])
    const two = directories.createFixture(first, 'next', source, ['source.js'])
    const other = directories.createFixture(second, 'next', source, ['source.js'])
    assert.notStrictEqual(first, second)
    assert.notStrictEqual(one, two)
    assert.notStrictEqual(one, other)
    assert.strictEqual(fs.readFileSync(path.join(one, 'source.js'), 'utf8'), 'fixture')
    assert.strictEqual(fs.existsSync(path.join(one, '.next')), false)
  })

  it('rejects invalid roots, labels and sources without escaping ownership', () => {
    const root = directories.createRunRoot()
    assert.throws(() => directories.createFixture(undefined, 'next', source, []), /Invalid fixture allocation/)
    assert.throws(() => directories.createFixture(root, '../escape', source, []), /Invalid fixture allocation/)
    for (const name of ['', '../escape', '.', '..']) {
      assert.throws(() => directories.createFixture(root, 'next', source, [name]), /direct children/)
    }
    assert.strictEqual(fs.readdirSync(root).length, 4)
  })

  it('owns partial copies before setup fails and reclaims every root', async () => {
    const root = directories.createRunRoot()
    assert.throws(() => directories.createFixture(root, 'next', source, ['source.js', 'missing']), { code: 'ENOENT' })
    const [entry] = fs.readdirSync(root)
    assert.strictEqual(fs.existsSync(path.join(root, entry, 'source.js')), true)
    await directories.cleanup()
    assert.strictEqual(fs.existsSync(root), false)
    assert.strictEqual(fs.existsSync(source), false)
  })

  it('accepts missing roots and children without following symlinks', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-fixture-target-'))
    try {
      fs.writeFileSync(path.join(outside, 'survivor'), 'keep')
      const root = directories.createRunRoot()
      const directory = directories.createFixture(root, 'next', source, [])
      fs.symlinkSync(outside, path.join(directory, 'link'), 'dir')
      const replaced = directories.createRunRoot()
      fs.rmSync(replaced, { recursive: true })
      fs.symlinkSync(outside, replaced, 'dir')
      const replacedFile = directories.createRunRoot()
      fs.rmSync(replacedFile, { recursive: true })
      fs.writeFileSync(replacedFile, 'replaced root')
      const missing = directories.createRunRoot()
      fs.rmSync(missing, { recursive: true })
      fs.rmSync(path.join(source, 'source.js'))
      await directories.cleanup()
      assert.strictEqual(fs.existsSync(root), false)
      assert.strictEqual(fs.existsSync(replaced), false)
      assert.strictEqual(fs.existsSync(replacedFile), false)
      assert.strictEqual(fs.readFileSync(path.join(outside, 'survivor'), 'utf8'), 'keep')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('attempts all roots and children, preserves failures, never retries failed children', async () => {
    const root = directories.createRunRoot()
    const failed = directories.createFixture(root, 'next', source, ['source.js'])
    const sibling = directories.createFixture(root, 'next', source, ['source.js'])
    const remove = fs.promises.rm.bind(fs.promises)
    const stub = sinon.stub(fs.promises, 'rm').callsFake(async (target, options) => {
      if (target === failed) throw Object.assign(new Error('private error payload'), { code: 'EACCES' })
      return remove(target, options)
    })
    await assert.rejects(directories.cleanup(), error => {
      assert.deepStrictEqual(error.errors.map(item => item.code).sort(), ['EACCES', 'ENOTEMPTY'])
      assert.strictEqual(error.errors[0].message.includes('private error payload'), false)
      return true
    })
    assert.strictEqual(stub.getCalls().filter(call => call.args[0] === failed).length, 1)
    assert.strictEqual(fs.existsSync(sibling), false)
    assert.strictEqual(fs.existsSync(source), false)
    stub.restore()
  })

  it('sanitizes unrecognized filesystem errors without disclosing their payload', async () => {
    const root = directories.createRunRoot()
    const failed = directories.createFixture(root, 'next', source, [])
    const remove = fs.promises.rm.bind(fs.promises)
    sinon.stub(fs.promises, 'rm').callsFake(async (target, options) => {
      if (target === failed) throw Object.assign(new Error('private payload'), { code: 'private code' })
      return remove(target, options)
    })
    await assert.rejects(directories.cleanup(), error => {
      assert.deepStrictEqual(error.errors.map(item => item.code).sort(), ['ENOTEMPTY', 'UNKNOWN'])
      for (const item of error.errors) {
        assert.doesNotMatch(item.message, /private payload|private code/)
        assert.ok(item.path === root || item.path === failed)
      }
      return true
    })
  })

  it('does not complete reclamation until controlled deletion resolves', async () => {
    const root = directories.createRunRoot()
    const directory = directories.createFixture(root, 'next', source, [])
    const remove = fs.promises.rm.bind(fs.promises)
    let release
    let entered
    const gate = new Promise(resolve => { release = resolve })
    const pending = new Promise(resolve => { entered = resolve })
    sinon.stub(fs.promises, 'rm').callsFake(async (target, options) => {
      if (target === directory) {
        entered()
        await gate
      }
      return remove(target, options)
    })
    let complete = false
    const cleanup = directories.cleanup().then(() => { complete = true })
    await pending
    assert.strictEqual(complete, false)
    assert.strictEqual(fs.existsSync(directory), true)
    release()
    await cleanup
    assert.strictEqual(complete, true)
    assert.strictEqual(fs.existsSync(root), false)
  })
})

describe('Mocha fixture entrypoints', () => {
  let scratch
  const children = []

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-fixture-entrypoint-'))
  })

  afterEach(async () => {
    await Promise.all(children.splice(0).map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise(resolve => child.once('close', resolve))
      }
    }))
    for (const file of fs.readdirSync(scratch).filter(name => name.endsWith('.roots'))) {
      for (const root of JSON.parse(fs.readFileSync(path.join(scratch, file), 'utf8'))) {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  for (const runner of ['cli', 'custom']) {
    const outcomes = ['success', 'test-failure', 'before-failure', 'setup-failure',
      'partial-setup-failure', 'partial-setup-and-cleanup-failure', 'cleanup-failure']
    for (const outcome of outcomes) {
      it(`${runner}: ${outcome} respects fixture lifetime and failure status`, async () => {
        const marker = path.join(scratch, 'run.roots')
        const probe = path.join(scratch, 'probe.js')
        const fixture = path.join(scratch, 'fixture.js')
        fs.writeFileSync(probe, `
          const fs = require('node:fs')
          const assert = require('node:assert/strict')
          const setup = require(${JSON.stringify(setup)})
          const previousRoot = process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}]
          const globalSetup = setup.mochaGlobalSetup
          setup.mochaGlobalSetup = async function () {
            try { await globalSetup.call(this) } catch (error) {
              assert.strictEqual(process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}], previousRoot)
              process.stderr.write('fixture-env-restored\\n')
              throw error
            }
          }
          const teardown = setup.mochaGlobalTeardown
          setup.mochaGlobalTeardown = async function () {
            try { await teardown.call(this) } finally {
              assert.strictEqual(process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}], previousRoot)
              process.stderr.write('fixture-env-restored\\n')
            }
          }
          if (${JSON.stringify(outcome)} === 'setup-failure') {
            fs.mkdtempSync = () => {
              throw Object.assign(new Error('private setup payload'), { code: 'EACCES' })
            }
          }
          if (${JSON.stringify(outcome)}.startsWith('partial-setup')) {
            const { FixtureDirectories } = require(${JSON.stringify(helper)})
            const allocate = FixtureDirectories.prototype.createRunRoot
            FixtureDirectories.prototype.createRunRoot = function () {
              const root = allocate.call(this)
              fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([root]))
              fs.writeFileSync(root + '/partial', 'owned')
              throw Object.assign(new Error('private setup payload'), { code: 'EACCES' })
            }
          }
          if (${JSON.stringify(outcome)}.includes('cleanup-failure')) {
            fs.promises.rm = async () => {
              throw Object.assign(new Error('private cleanup payload'), { code: 'EACCES' })
            }
          }
        `)
        fs.writeFileSync(fixture, fixtureBody(marker, `
          if (${JSON.stringify(outcome)} === 'before-failure') {
            before(() => { throw new Error('expected before failure') })
          }
          it('observable assertion', () => {
            require('node:assert/strict').strictEqual(${JSON.stringify(outcome)} === 'test-failure', false)
          })
        `))
        const result = await launch(runner, fixture, [probe]).completed
        assert.strictEqual(result.code, outcome === 'success' ? 0 : 1)
        assert.strictEqual(result.stderr.includes('private setup payload'), false)
        assert.strictEqual(result.stderr.includes('private cleanup payload'), false)
        if (outcome === 'setup-failure' || outcome.startsWith('partial-setup')) {
          assert.match(result.stderr, /phase=setup code=EACCES path=/)
          if (outcome === 'setup-failure') {
            assert.strictEqual(fs.existsSync(marker), false)
          } else {
            assert.strictEqual(fs.existsSync(JSON.parse(fs.readFileSync(marker, 'utf8'))[0]),
              outcome === 'partial-setup-and-cleanup-failure')
          }
          if (outcome === 'partial-setup-and-cleanup-failure') {
            assert.match(result.stderr, /code=EACCES.*code=EACCES.*code=ENOTEMPTY/)
          }
          assert.match(result.stderr, /fixture-env-restored/)
        } else {
          const [root] = JSON.parse(fs.readFileSync(marker, 'utf8'))
          assert.strictEqual(fs.existsSync(root), outcome === 'cleanup-failure')
          assert.match(result.stderr, /fixture-env-restored/)
          if (outcome === 'cleanup-failure') assert.match(result.stderr, /phase=cleanup code=EACCES path=/)
          else if (outcome === 'before-failure') assert.match(result.stdout, /expected before failure/)
          else assert.match(result.stdout, /"tests": 1/)
        }
      })
    }

    it(`${runner}: reclaims both version allocations in one command`, async () => {
      const fixture = path.join(scratch, 'versions.js')
      const first = path.join(scratch, 'first.roots')
      const second = path.join(scratch, 'second.roots')
      fs.writeFileSync(fixture, `
        { ${fixtureBody(first, "it('first version', () => {})")} }
        { ${fixtureBody(second, `
          it('second version retains the first allocation', () => {
            const [, directory] = JSON.parse(fs.readFileSync(${JSON.stringify(first)}, 'utf8'))
            require('node:assert/strict').strictEqual(fs.readFileSync(directory + '/generated', 'utf8'), 'owned')
          })
        `)} }
        after(() => {
          const fs = require('node:fs')
          for (const marker of ${JSON.stringify([first, second])}) {
            const [, directory] = JSON.parse(fs.readFileSync(marker, 'utf8'))
            require('node:assert/strict').strictEqual(fs.readFileSync(directory + '/generated', 'utf8'), 'owned')
          }
        })
      `)
      const result = await launch(runner, fixture).completed
      assert.strictEqual(result.code, 0)
      assert.match(result.stdout, /"tests": 2/)
      const [one, two] = [first, second].map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
      assert.strictEqual(one[0], two[0])
      assert.notStrictEqual(one[1], two[1])
      for (const target of [...one, ...two]) assert.strictEqual(fs.existsSync(target), false)
    })

    it(`${runner}: reclaims an empty run root`, async () => {
      const marker = path.join(scratch, 'empty.roots')
      const probe = path.join(scratch, 'empty.js')
      const fixture = path.join(scratch, 'empty-spec.js')
      fs.writeFileSync(probe, `
        const fs = require('node:fs')
        const setup = require(${JSON.stringify(setup)})
        const allocate = setup.mochaGlobalSetup
        setup.mochaGlobalSetup = async function () {
          await allocate.call(this)
          const root = process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}]
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([root]))
        }
      `)
      fs.writeFileSync(fixture, "'use strict'\n")
      const result = await launch(runner, fixture, [probe]).completed
      assert.strictEqual(result.code, 0)
      assert.match(result.stdout, /"tests": 0/)
      const [root] = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.strictEqual(fs.existsSync(root), false)
    })

    it(`${runner}: registers fixture arrays and restores an absent environment root`, async () => {
      const marker = path.join(scratch, 'array.roots')
      const probe = path.join(scratch, 'arrays.js')
      const fixture = path.join(scratch, 'fixture.js')
      const steps = path.join(scratch, 'steps.json')
      fs.writeFileSync(probe, `
        const assert = require('node:assert/strict')
        const fs = require('node:fs')
        const setup = require(${JSON.stringify(setup)})
        delete process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}]
        let calls = []
        exports.mochaGlobalSetup = [() => calls.push('setup-one'), async () => calls.push('setup-two')]
        exports.mochaGlobalTeardown = [() => calls.push('teardown-one'), async () => calls.push('teardown-two')]
        const teardown = setup.mochaGlobalTeardown
        setup.mochaGlobalTeardown = async function () {
          await teardown.call(this)
          assert.strictEqual(Object.hasOwn(process.env, ${JSON.stringify(FIXTURE_ROOT_ENV)}), false)
          fs.writeFileSync(${JSON.stringify(steps)}, JSON.stringify(calls))
        }
      `)
      fs.writeFileSync(fixture, fixtureBody(marker, "it('passes', () => {})"))
      assert.strictEqual((await launch(runner, fixture, [probe]).completed).code, 0)
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(steps, 'utf8')),
        ['setup-one', 'setup-two', 'teardown-one', 'teardown-two'])
      const [root] = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.strictEqual(fs.existsSync(root), false)
    })

    it(`${runner}: command completion waits for physical deletion`, async () => {
      const marker = path.join(scratch, 'gate.roots')
      const probe = path.join(scratch, 'gate.js')
      const fixture = path.join(scratch, 'fixture.js')
      fs.writeFileSync(probe, `
        const fs = require('node:fs')
        const remove = fs.promises.rm.bind(fs.promises)
        fs.promises.rm = async (target, options) => {
          process.send({ phase: 'pending', target })
          await new Promise(resolve => process.once('message', resolve))
          await remove(target, options)
          process.disconnect()
        }
      `)
      fs.writeFileSync(fixture, fixtureBody(marker, "it('passes', () => {})"))
      const running = launch(runner, fixture, [probe])
      const message = await running.waitForMessage()
      assert.strictEqual(fs.existsSync(message.target), true)
      assert.strictEqual(running.child.exitCode, null)
      running.child.send('release')
      const result = await running.completed
      assert.strictEqual(result.code, 0)
      const [root] = JSON.parse(fs.readFileSync(marker, 'utf8'))
      assert.strictEqual(fs.existsSync(root), false)
    })
  }

  it('keeps the existing watchdog armed while global deletion is pending', async () => {
    const fixture = path.join(scratch, 'watchdog.js')
    fs.writeFileSync(fixture, `
      const assert = require('node:assert/strict')
      const fs = require('node:fs')
      const sinon = require(${JSON.stringify(require.resolve('sinon'))})
      const originalExit = process.exit
      const exits = []
      process.exit = code => { exits.push(code) }
      const setup = require(${JSON.stringify(setup)})
      const { FixtureDirectories } = require(${JSON.stringify(helper)})
      const clock = sinon.useFakeTimers()
      sinon.stub(console, 'error')
      const remove = fs.promises.rm.bind(fs.promises)
      let release
      let entered
      const gate = new Promise(resolve => { release = resolve })
      const pending = new Promise(resolve => { entered = resolve })
      fs.promises.rm = async (target, options) => {
        entered()
        await gate
        await remove(target, options)
      }
      ;(async () => {
        await setup.mochaGlobalSetup()
        const root = process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}]
        new FixtureDirectories().createFixture(root, 'next', ${JSON.stringify(__dirname)}, [])
        setup.mochaHooks.afterAll()
        const cleanup = setup.mochaGlobalTeardown()
        await pending
        clock.tick(119999)
        assert.deepStrictEqual(exits, [])
        clock.tick(1)
        assert.deepStrictEqual(exits, [1])
        release()
        await cleanup
        assert.strictEqual(fs.existsSync(root), false)
        clock.restore()
        sinon.restore()
        originalExit(0)
      })().catch(() => originalExit(1))
    `)
    const child = spawn(process.execPath, [fixture], { cwd: checkout, stdio: 'ignore' })
    children.push(child)
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.strictEqual(code, 0)
  })

  it('shares parent ownership across parallel workers with distinct version directories', async () => {
    const first = path.join(scratch, 'first.js')
    const second = path.join(scratch, 'second.js')
    const sockets = new Set()
    const records = []
    let release = false
    let ready
    let fail
    let running
    const readiness = new Promise((resolve, reject) => { ready = resolve; fail = reject })
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.setEncoding('utf8')
      socket.once('error', fail)
      socket.once('close', () => {
        sockets.delete(socket)
        if (!release) fail(new Error('Worker disconnected before release'))
      })
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        try {
          records.push(JSON.parse(buffer.slice(0, newline)))
          buffer = buffer.slice(newline + 1)
          if (records.length === 2) ready()
        } catch (error) {
          fail(error)
        }
      })
    })
    server.on('error', fail)
    try {
      await Promise.race([
        new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
        readiness,
      ])
      const { port } = server.address()
      for (const [index, file] of [first, second].entries()) {
        const marker = path.join(scratch, `workers-${index}.roots`)
        fs.writeFileSync(file, fixtureBody(marker, `
          it('holds its worker allocation until parent release', async () => {
            const [root, directory] = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8'))
            await new Promise((resolve, reject) => {
              const socket = require('node:net').createConnection(${port}, '127.0.0.1')
              socket.once('error', reject)
              socket.once('connect', () => {
                socket.write(JSON.stringify({ workerId: process.env.MOCHA_WORKER_ID,
                  pid: process.pid, root, directory }) + '\\n')
              })
              socket.setEncoding('utf8')
              let buffer = ''
              socket.on('data', chunk => { buffer += chunk })
              socket.once('end', () => {
                try {
                  require('node:assert/strict').strictEqual(buffer, 'release\\n')
                  resolve()
                } catch (error) {
                  reject(error)
                } finally {
                  socket.destroy()
                }
              })
            })
          })
        `))
      }
      running = launch('cli', first, [], ['--parallel', '--jobs', '2', second])
      await Promise.race([
        readiness,
        running.completed.then(() => { throw new Error('Fixture command completed before both workers were ready') }),
      ])
      assert.strictEqual(records.length, 2)
      assert.strictEqual(sockets.size, 2)
      for (const record of records) {
        assert.match(record.workerId, /^\d+$/)
        assert.ok(Number.isInteger(record.pid))
        assert.strictEqual(fs.readFileSync(path.join(record.directory, 'generated'), 'utf8'), 'owned')
      }
      assert.notStrictEqual(records[0].workerId, records[1].workerId)
      assert.notStrictEqual(records[0].pid, records[1].pid)
      assert.strictEqual(records[0].root, records[1].root)
      assert.notStrictEqual(records[0].directory, records[1].directory)
      release = true
      for (const socket of sockets) socket.end('release\n')
      const result = await running.completed
      assert.strictEqual(result.code, 0)
      assert.strictEqual(fs.existsSync(records[0].root), false)
    } finally {
      for (const socket of sockets) socket.destroy()
      if (running && running.child.exitCode === null && running.child.signalCode === null) {
        running.child.kill('SIGKILL')
      }
      await Promise.all([
        running?.completed.catch(() => {}),
        new Promise(resolve => {
          if (server.listening) server.close(resolve)
          else resolve()
        }),
      ])
    }
  })

  it('keeps independent commands isolated while one run remains live', async () => {
    const marker = path.join(scratch, 'first.roots')
    const first = path.join(scratch, 'first.js')
    const second = path.join(scratch, 'second.js')
    fs.writeFileSync(first, fixtureBody(marker, `
      it('holds its allocation', async () => {
        process.send({ phase: 'live' })
        await new Promise(resolve => process.once('message', resolve))
        process.disconnect()
      })
    `))
    const secondMarker = path.join(scratch, 'second.roots')
    fs.writeFileSync(second, fixtureBody(secondMarker, "it('passes', () => {})"))
    const live = launch('cli', first)
    await live.waitForMessage()
    const result = await launch('custom', second).completed
    assert.strictEqual(result.code, 0)
    const [firstRoot, firstApp] = JSON.parse(fs.readFileSync(marker, 'utf8'))
    const [secondRoot] = JSON.parse(fs.readFileSync(secondMarker, 'utf8'))
    assert.notStrictEqual(firstRoot, secondRoot)
    assert.strictEqual(fs.existsSync(secondRoot), false)
    assert.strictEqual(fs.existsSync(firstApp), true)
    live.child.send('release')
    assert.strictEqual((await live.completed).code, 0)
    assert.strictEqual(fs.existsSync(firstRoot), false)
  })

  /**
   * @param {string} runner
   * @param {string} fixture
   * @param {string[]} [requires]
   * @param {string[]} [args]
   */
  function launch (runner, fixture, requires = [], args = []) {
    const env = {
      ...process.env,
      CI: '',
      MOCHA_RUN_FILE_CONFIG: JSON.stringify({ reporter: 'json', color: false, require: requires }),
    }
    delete env.NODE_OPTIONS
    const command = runner === 'cli'
      ? [cli, '--no-config', '--reporter', 'json', '--exit',
          ...requires.flatMap(file => ['--require', file]), '--require', setup, ...args, fixture]
      : [custom, fixture]
    const child = spawn(process.execPath, command, { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const message = new Promise(resolve => child.once('message', resolve))
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
    const waitForMessage = () => Promise.race([
      message,
      completed.then(() => { throw new Error('Fixture command completed without an expected message') }),
    ])
    return { child, waitForMessage, completed }
  }
})

/**
 * @param {string} marker
 * @param {string} tests
 */
function fixtureBody (marker, tests) {
  return `
    const fs = require('node:fs')
    const { FixtureDirectories } = require(${JSON.stringify(helper)})
    describe('version fixture', () => {
      before(() => {
        const root = process.env[${JSON.stringify(FIXTURE_ROOT_ENV)}]
        const directory = new FixtureDirectories().createFixture(root, 'next', ${JSON.stringify(__dirname)}, [])
        fs.writeFileSync(directory + '/generated', 'owned')
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([root, directory]))
      })
      ${tests}
    })
  `
}
