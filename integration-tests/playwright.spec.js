'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const webAppServer = require('./ci-visibility/web-app-server')

describe.only('playwright', () => {
  let sandbox, cwd, receiver, childProcess, webAppPort
  before(async () => {
    sandbox = await createSandbox(['@playwright/test'], true)
    cwd = sandbox.folder
    // install necessary browser
    await execSync('npx playwright install', { cwd })
    webAppPort = await getPort()
    debugger
    webAppServer.listen(webAppPort)
  })

  after(async () => {
    await sandbox.remove()
    await new Promise(resolve => webAppServer.close(resolve))
  })

  beforeEach(async function () {
    const port = await getPort()
    receiver = await new FakeCiVisIntake(port).start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })
  const reportMethods = ['agentless' ]//'evp proxy']

  reportMethods.forEach((reportMethod) => {
    context(`reporting via ${reportMethod}`, () => {
      it('can run and report tests', (done) => {
        const envVars = reportMethod === 'agentless'
          ? getCiVisAgentlessConfig(receiver.port) : getCiVisEvpProxyConfig(receiver.port)
        const reportUrl = reportMethod === 'agentless' ? '/api/v2/citestcycle' : '/evp_proxy/v2/api/v2/citestcycle'

        receiver.gatherPayloads(({ url }) => url === reportUrl).then(payloads => {
          debugger
          done()
        }, 5000)

        childProcess = exec(
          './node_modules/.bin/playwright test',
          {
            cwd,
            env: {
              ...envVars,
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )
        childProcess.stdout.pipe(process.stdout)
        childProcess.stderr.pipe(process.stderr)
      })
    })
  })
})
