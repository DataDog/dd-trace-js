function dummyOperation (a) {
  return a + 'should have ' + 'dummy operation to be rewritten' + ' without crashing'
}

export async function initialize () {
  dummyOperation('should have')
}

export async function load (url, context, nextLoad) {
  return nextLoad(url, context)
}
