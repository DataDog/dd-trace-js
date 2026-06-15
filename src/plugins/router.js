const { Plugin } = require('../plugin');
const { Span } = require('../span');
const { Tracer } = require('../tracer');
const { Tags } = require('../tags');
const { config } = require('../config');
const { log } = require('../log');

const RouterPlugin = class RouterPlugin extends Plugin {
  constructor(...args) {
    super(...args);
    this.tracer = new Tracer();
    this.config = config.get('router');
  }

  configure(options) {
    if (options.middleware === false) {
      this.config.middleware = false;
    }
  }

  start() {
    this.tracer.use('router', this);
  }

  stop() {
    this.tracer.unuse('router');
  }

  createSpan(name, options) {
    const span = new Span(name, options);
    span.setTag(Tags.COMPONENT, 'router');
    span.setTag(Tags.SPAN_KIND, 'server');
    return span;
  }
};

module.exports = RouterPlugin;