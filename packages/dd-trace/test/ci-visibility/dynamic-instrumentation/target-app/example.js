const vm = require('vm')
const path = require('path')
const fs = require('fs')
const { Worker } = require('node:worker_threads')
// const sum = require('./di-dependency')

const worker = new Worker(
  path.join(__dirname, 'fake-worker.js'),
  {
    execArgv: [],
    env: process.env
  }
)

worker.on('online', () => {
  console.log('worker is online')
})

worker.on('error', (err) => {
  console.error(err)
})

worker.on('exit', (code) => {
  console.log('worker exited with code:', code)
})

const filename = path.join(__dirname, 'di-dependency.js')
const code = fs.readFileSync(filename)

const script = new vm.Script(code, { filename })

const context = vm.createContext({ console, module })

const sum = script.runInContext(context, { filename })

async function run () {
  setTimeout(() => {
    console.log('sum:', sum(1, 2))
  }, 1000)
}

run()
