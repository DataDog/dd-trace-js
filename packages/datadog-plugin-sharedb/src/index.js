'use strict';

const MessagesAwaitingResponse = new WeakMap();
const READABLE_ACTION_NAMES = {
  hs: 'handshake',
  qf: 'query-fetch',
  qs: 'query-subscribe',
  qu: 'query-unsubscribe',
  bf: 'bulk-fetch',
  bs: 'bulk-subscribe',
  bu: 'bulk-unsubscribe',
  f: 'fetch',
  s: 'subscribe',
  u: 'unsubscribe',
  op: 'op',
  nf: 'snapshot-fetch',
  nt: 'snapshot-fetch-by-ts',
  p: 'presence-broadcast',
  pr: 'presence-request',
  ps: 'presence-subscribe',
  pu: 'presence-unsubscribe'
};

function getReadableActionName(action) {
  let actionName = READABLE_ACTION_NAMES[action];
  if (actionName === undefined) {
    return action;
  }
  return actionName;
}

function getReadableResourceName(readableActionName, collection, query) {
  if (collection) {
    readableActionName += ' ' + collection;
  }
  if (query) {
    readableActionName += ' ' + JSON.stringify(sanitize(query));
  }
  return readableActionName;
}

function sanitize (input) {
  const output = {}

  if (!isObject(input) || Buffer.isBuffer(input)) return '?'

  for (const key in input) {
    if (typeof input[key] === 'function') continue

    output[key] = sanitize(input[key])
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

function createWrapHandle(tracer, config) { // called once
  return function wrapTrigger(triggerFn) { // called once
    return function handleMessageWithTrace(action, agent, triggerContext, callback) { // called for each trigger
      /**
       * What we're doing here is tying ourselves into the ShareDB Backend middleware.
       * This allows us to create traces for all events that have triggers, like receiving a message and replying
       * to it. The benefit of doing this over wrapping the connection class is that both the receive and reply
       * triggers have access to a reference of the original request object. This allows us to use a WeakMap to
       * store the span call backs to help prevent memory leaks.
       *
       */
      switch (action) {
        case 'receive':
          if (triggerContext.data && triggerContext.data.a) {
            const scope = tracer.scope();
            const childOf = scope.active();
            // Call the trigger function to continue the middleware chain.
            return triggerFn.call(this, action, agent, triggerContext, function wrappedCallback(err) {
              // When the middleware calls back into us, start a trace.
              const actionName = getReadableActionName(triggerContext.data.a);
              tracer.trace(
                'sharedb.request',
                {
                  childOf,
                  tags: {
                    'service.name': config.service || `${tracer._service}-sharedb`,
                    'span.type': 'sharedb.request',
                    'span.kind': 'client',
                    'resource.method': actionName,
                    'resource.name': getReadableResourceName(actionName, triggerContext.data.c, triggerContext.data.q)
                  }
                },
                (span, spanDoneCb) => {
                  if (config.hooks && config.hooks.receive) {
                    config.hooks.receive(span, agent, triggerContext);
                  }
                  if (span) {
                    MessagesAwaitingResponse.set(triggerContext.data, {
                      span,
                      spanDoneCb
                    });
                  }
                  callback(err);
                });
            });
          } else {
            return triggerFn.apply(this, arguments);
          }
        case 'reply':
          const replySpanInfo = MessagesAwaitingResponse.get(triggerContext.request);
          if (replySpanInfo) {
            if (config.hooks && config.hooks.reply) {
              config.hooks.reply(replySpanInfo.span, triggerContext);
            }
            replySpanInfo.spanDoneCb();
            MessagesAwaitingResponse.delete(triggerContext.request);
          }
          return triggerFn.apply(this, arguments);
        case 'send':
          const sendSpanInfo = MessagesAwaitingResponse.get(triggerContext);
          if (sendSpanInfo) {
            if (config.hooks && config.hooks.reply) {
              config.hooks.reply(sendSpanInfo.span, triggerContext);
            }
            sendSpanInfo.spanDoneCb();
            MessagesAwaitingResponse.delete(triggerContext);
          }
          return triggerFn.apply(this, arguments);
        default:
          return triggerFn.apply(this, arguments);
      }
    };
  };
}

module.exports = {
  name: 'sharedb',
  versions: ['>=1'],
  file: 'lib/backend.js',
  patch(Backend, tracer, config) {
    this.wrap(Backend.prototype, 'trigger', createWrapHandle(tracer, config));
  },
  unpatch(Backend) {
    this.unwrap(Backend.prototype, 'trigger');
  }
};
