'use strict'

module.exports = ['dist/index.js', 'dist/chunk-hooks.js'].map(filePath => ({
  module: { name: '@vitest/runner', versionRange: '>=1.6.0 <4.1.0', filePath },
  astQuery: 'FunctionDeclaration[id.name="createSuiteCollector"] ' +
    'VariableDeclarator[id.name="task"] > FunctionExpression',
  channelName: 'createTestTask',
}))
