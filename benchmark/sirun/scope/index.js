
const {
  DD_TRACE_SCOPE,
  COUNT
} = process.env

if (DD_TRACE_SCOPE) {
  const Scope = require('../../../packages/dd-trace/src/scope')
  const scope = new Scope()
  if (scope.enable) {
    scope.enable()
  }
}

function promises (n, cb) {
  let p = Promise.resolve()
  for (let i = 1; i < n; i++) {
    p = p.then(() => {})
  }
  p.then(cb)
}

function awaits (n, cb) {
  (async () => {
    for (let i = 0; i < n; i++) {
      await 0
    }
  })().then(cb)
}

function immediates (n, cb) {
  if (n === 0) {
    cb()
    return
  }
  setImmediate(immediates, n - 1, cb)
}

function timeouts (n, cb) {
  if (n === 0) {
    cb()
    return
  }
  setTimeout(timeouts, 0, n - 1, cb)
}

promises(COUNT, () => {
  awaits(COUNT, () => {
    immediates(COUNT, () => {
      timeouts(COUNT, () => {
      })
    })
  })
})
