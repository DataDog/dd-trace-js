const { spawn } = require('child_process')
const { assert } = require('chai')
const path = require('path')

describe('serverless', () => {
  it('mini agent spawned and receives traces', async () => {
    let testOutput = ''

    const child = await spawn(
      path.join(__dirname, 'test-gcloud-function.sh'),
      { env: { ...process.env, SERVERLESS_INTEGRATION_DIR_PATH: __dirname } }
    )

    child.stdout.on('data', (data) => {
      console.log(data.toString()) // eslint-disable-line no-console
      testOutput += data
    })

    child.stderr.on('data', (data) => {
      console.log(data.toString()) // eslint-disable-line no-console
      testOutput += data
    })

    await new Promise((resolve) => {
      child.on('close', resolve)
    })
    assert.strictEqual(child.exitCode, 0)
    assert.include(testOutput, 'Mini Agent received traces')
  }).timeout(400000)
})
