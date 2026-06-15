const { Plugin } = require('../plugin');
const { Span } = require('../span');
const { Tracer } = require('../tracer');
const { Tags } = require('../tags');
const { config } = require('../config');
const { log } = require('../log');
const RouterPlugin = require('./router');

const ExpressPlugin = class ExpressPlugin extends Plugin {
  constructor(...args) {
    super(...args);
    this.tracer = new Tracer();
    this.config = config.get('express');
    this.routerPlugin = new RouterPlugin();
  }

  configure(options) {
    if (options.middleware === false) {
      this.config.middleware = false;
      this.routerPlugin.configure({ middleware: false });
    }
  }

  start() {
    this.tracer.use('express', this);
    this.routerPlugin.start();
  }

  stop() {
    this.tracer.unuse('express');
    this.routerPlugin.stop();
  }

  createSpan(name, options) {
    const span = new Span(name, options);
    span.setTag(Tags.COMPONENT, 'express');
    span.setTag(Tags.SPAN_KIND, 'server');
    return span;
  }
};

module.exports = ExpressPlugin;