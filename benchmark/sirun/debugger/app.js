'use strict'

// WARNING: CHANGES TO THIS FUNCTION WILL AFFECT THE LINE NUMBERS OF THE BREAKPOINTS

if (process.env.DD_DYNAMIC_INSTRUMENTATION_ENABLED === 'true') {
  require('./start-devtools-client')
}

let n = 0

// Give the devtools client time to connect before doing work
setTimeout(doSomeWork, 250)

function doSomeWork (arg1 = 1, arg2 = 2) {
  const data = getSomeData()
  data.n = n
  if (++n <= 250) {
    setTimeout(doSomeWork, 1)
  }
}

// Location to put dummy breakpoint that is never hit:
// eslint-disable-next-line no-unused-vars
function dummy () {
  throw new Error('This line should never execute')
}

function getSomeData () {
  const str = 'a'.repeat(1000)
  const arr = Array.from({ length: 1000 }, (_, i) => i)

  const data = {
    foo: 'bar',
    nil: null,
    undef: undefined,
    bool: true
  }
  data.recursive = data

  for (let i = 0; i < 20; i++) {
    data[`str${i}`] = str
    data[`arr${i}`] = arr
  }

  return data
}
