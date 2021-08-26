module.exports = (on, config) => {
  // We can't use the tracer available in the testing process, because this code is
  // run in a different process. We need to init a different tracer reporting to the
  // url set by the plugin agent
  require('../../../../../dd-trace').init({ port: config.env.agent_port, startupLogs: false, plugins: false })
  require('../../../../src/plugin')(on, config)
}
