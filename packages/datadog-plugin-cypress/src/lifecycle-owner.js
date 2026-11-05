'use strict'

// Older manual support predates the shared installation marker. Its lifecycle
// still registers these two stable Datadog task hooks on the Mocha root.
function callsTask (hook, name) {
  if (!hook || typeof hook.fn !== 'function') return false
  // Keep string literals as single tokens and omit comments, so documentation
  // or a quoted example cannot masquerade as an actual task invocation.
  const tokens = Function.prototype.toString.call(hook.fn)
    .match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) || []
  const code = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'))
  return code.some((token, index) => token === '.' && code[index + 1] === 'task' &&
    code[index + 2] === '(' && (code[index + 3] === `"${name}"` || code[index + 3] === `'${name}'`))
}

module.exports = function hasCypressLifecycle (root) {
  return Boolean(root && root._beforeAll && root._afterEach &&
    root._beforeAll.some(hook => callsTask(hook, 'dd:testSuiteStart')) &&
    root._afterEach.some(hook => callsTask(hook, 'dd:afterEach')))
}
