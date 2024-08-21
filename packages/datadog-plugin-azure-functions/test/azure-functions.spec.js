'use strict'

const spawn = require('cross-spawn')
const waitOn = require('wait-on')

const agent = require('../../dd-trace/test/plugins/agent')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

// describe('azure-functions testsing', function () {
describe('azure-functions testsing', () => {
  withVersions('azure-functions', ['@azure/functions'], (version, moduleName) => {
    let child
    let tracer

    before(async () => {
      tracer = require('../../dd-trace')
      const clear = await freePort()
      clear.stdout.on('data', async (data) => {
        console.log(`stdout-: ${data}`)
      })

      clear.stderr.on('data', (data) => {
        console.error(`stderr-: ${data}`)
      })

      clear.on('close', (code) => {
        console.log(`lsof process exited with code ${code}`)
      })
      return agent.load('azure-functions')
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    beforeEach(async () => {
      child = await start()
      child.stdout.on('data', async (data) => {
        console.log(`stdout-: ${data}`)
      })

      child.stderr.on('data', (data) => {
        console.error(`stderr-: ${data}`)
      })

      child.on('close', (code) => {
        console.log(`lsof process exited with code ${code}`)
      })
    })

    afterEach(() => {
      console.log('after each')
      stopProcess(child)
      console.log('stopped process')
    })

    it('span generation', async () => {
      console.log('in try fetch')
      try {
        const res = await fetch('http://127.0.0.1:7071/api/MyHttpTrigger')
        console.log('finished fetch')
      } catch (error) {
        console.log('error => :', error)
      }

      const checkTraces = agent.use(traces => { // where does this traces array come from
        console.log('here in check traces')
        const span = sort(traces[0])[0] // what is there to sort?

        expect(span).to.include({
          name: 'aws.request',
          resource: 'listBuckets',
          service: 'test-aws-s3'
        })

        expect(span.meta).to.include({
          component: 'aws-sdk',
          'aws.region': 'us-east-1',
          region: 'us-east-1',
          'aws.service': 'S3',
          aws_service: 'S3',
          'aws.operation': 'listBuckets'
        })
      })
      await checkTraces
    })
  })
})

async function freePort () {
  const port = await spawn("pid=$(lsof -i tcp:7071 | awk 'NR==2 {print $2}') && [ -n '$pid' ] && kill -9 ${pid}", {
    shell: true
  })
  await waitOn({
    resources: [
      'tcp:localhost:7071'
    ],
    reverse: true,
    timeout: 3000,
    log: true
  })
  console.log('freed port')
  return port
}

async function start () {
  const child = spawn('cd packages/datadog-plugin-azure-functions/test && func start', {
    shell: true
  })
  await waitOn({
    resources: [
      'tcp:localhost:7071'
    ],
    timeout: 3000,
    log: true
  })
  console.log('started app')
  return child
}

async function stopProcess (child) {
  await killAndWait(child)
}
async function killAndWait (proc) {
  const k = require('tree-kill')
  k(proc.pid, 'SIGKILL')
  while (isRunning(proc.pid)) {
    await setTimeoutPromise(1000)
  }
  // await waitOn({
  //   resources: [
  //     'tcp:localhost:7071'
  //   ],
  //   reverse: true,
  //   timeout: 3000,
  //   log: true
  // })clea
}

async function setTimeoutPromise (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function isRunning (pid) {
  if (!pid) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// child = await start()
// child.stdout.on('data', async (data) => {
//   console.log(`stdout-: ${data}`)
// })

// child.stderr.on('data', (data) => {
//   console.error(`stderr-: ${data}`)
// })

// child.on('close', (code) => {
//   console.log(`lsof process exited with code ${code}`)
// })
