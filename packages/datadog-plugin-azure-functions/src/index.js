const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AzureFunctionsPlugin extends TracingPlugin {
  static get id () {
    return 'azure-functions'
  }
  static get prefix () { return 'tracing:datadog:azure-functions:http' }

  start ({ name, options }) {
    console.log("==== starting span =====");
    this.startSpan('azure-inbound-web', {
      service: this.config.service || this._tracerConfig.service,
      resource: name,
      type: 'system',
      meta: {
        'azure-functions.name': name,
        'azure-functions.trigger': options.trigger
      }
    }, false)
  }

  end () {
    this.activeSpan?.finish()
  }

  error () {}

  asyncEnd () {
    console.log("async end");
    this.activeSpan?.finish();
  }
}

module.exports = AzureFunctionsPlugin