'use strict'

module.exports = [
  ['>=5.2.0 <12.0.0', 'lib/mocha.js'],
  ['>=12.0.0', 'lib/mocha.cjs'],
].map(([versionRange, filePath]) => ({
  module: { name: 'mocha', versionRange, filePath },
  astQuery: 'AssignmentExpression[left.object.object.name="Mocha"]' +
    '[left.object.property.name="prototype"][left.property.name="ui"] > FunctionExpression',
  channelName: 'ui',
}))
