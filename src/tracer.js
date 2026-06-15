const { Plugin } = require('./plugin');
const { Span } = require('./span');
const { Tags } = require('./tags');
const { config } = require('./config');
const { log } = require('./log');

const Tracer = class Tracer {
  constructor() {
    this.plugins = {};
  }

  use(pluginName, plugin) {
    this.plugins[pluginName] = plugin;
  }

  unuse(pluginName) {
    delete this.plugins[pluginName];
  }

  createSpan(name, options) {
    const plugin = this.plugins[name];
    if (plugin) {
      return plugin.createSpan(name, options);
    }
    return new Span(name, options);
  }
};

module.exports = Tracer;