'use strict'

const routerPrototype = 'AssignmentExpression[left.object.object.name="Router"][left.object.property.name="prototype"]'
const functionBody = ' > FunctionExpression > BlockStatement > '
const lookup = `${routerPrototype}[left.property.name="lookup"]`
const compiledLookup = `${routerPrototype}[left.property.name="_lookupCompiled"]`
const resolve = ':matches(VariableDeclarator, ExpressionStatement) > ' +
  'CallExpression:matches([callee.property.name="deriveConstraints"], [callee.property.name="find"])'

module.exports = [{
  module: { name: 'find-my-way', versionRange: '>=1', filePath: 'index.js' },
  functionQuery: { index: null },
  astQuery: `${lookup}${functionBody}:first-child, ` +
    `${compiledLookup}${functionBody}` +
    'VariableDeclaration:has(VariableDeclarator[id.name="derivedConstraints"])',
  transform: 'publishRoutingStart',
  channelName: 'lookup',
}, {
  module: { name: 'find-my-way', versionRange: '>=1', filePath: 'index.js' },
  functionQuery: { index: null },
  astQuery: `${lookup} ${resolve}, ${compiledLookup} ${resolve}, ` +
    `${compiledLookup} ReturnStatement > ` +
    'CallExpression[callee.object.name="compiled"][callee.property.name="lookup"], ' +
    `${compiledLookup} ReturnStatement > CallExpression[callee.property.name="_defaultRoute"]`,
  transform: 'scopeRoutingSelection',
  channelName: 'selection',
}, {
  module: { name: 'find-my-way', versionRange: '>=9', filePath: 'index.js' },
  functionQuery: { index: null },
  astQuery: `${routerPrototype}[left.property.name="_defaultRoute"]${functionBody}:first-child, ` +
    `${routerPrototype}[left.property.name="callHandler"]${functionBody}` +
    'IfStatement[test.left.name="handle"] + ReturnStatement',
  transform: 'publishRoutingStart',
  channelName: 'dispatch',
}, {
  module: { name: 'find-my-way', versionRange: '>=1', filePath: 'index.js' },
  astQuery: `${routerPrototype}[left.property.name="_defaultRoute"] > FunctionExpression`,
  channelName: 'defaultRoute',
}, {
  module: { name: 'find-my-way', versionRange: '>=2', filePath: 'index.js' },
  functionQuery: { index: null },
  astQuery: `${routerPrototype}[left.property.name=/^_on(BadUrl|MaxParamLength)$/] ` +
    'ReturnStatement > ObjectExpression > Property[key.name="handler"] > ArrowFunctionExpression',
  channelName: 'defaultRoute',
}]
