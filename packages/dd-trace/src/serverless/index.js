'use strict'

module.exports = {
  channels: require('./channels'),
  ...require('./flush-coordinator'),
  ...require('./invocation-processor'),
}
