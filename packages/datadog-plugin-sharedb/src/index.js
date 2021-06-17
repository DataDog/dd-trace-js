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

function createTraceName(action, collection) {
  let actionName = READABLE_ACTION_NAMES[action];
  if (actionName === undefined) {
    actionName = action;
  }
  let traceName = 'sharedb-request/' + actionName;
  if (collection) {
    traceName += '/' + collection;
  }
  return traceName;
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
            return triggerFn.call(this, action, agent, triggerContext, function wrappedCallback(err) {
              tracer.trace(
                createTraceName(triggerContext.data.a, triggerContext.data.c),
                { childOf },
                (span, spanDoneCb) => {
                  if (config.hooks && config.hooks.receive) {
                    config.hooks.receive(span, agent, triggerContext);
                  }
                  if (span) {
                    MessagesAwaitingResponse.set(triggerContext.data, spanDoneCb);
                  }
                  callback(err);
                });
            });
          } else {
            return triggerFn.apply(this, arguments);
          }
        case 'reply':
          const replySpanCallBack = MessagesAwaitingResponse.get(triggerContext.request);
          if (replySpanCallBack) {
            replySpanCallBack();
            MessagesAwaitingResponse.delete(triggerContext.request);
          }
          return triggerFn.apply(this, arguments);
        case 'send':
          const sendSpanCallBack = MessagesAwaitingResponse.get(triggerContext);
          if (sendSpanCallBack) {
            sendSpanCallBack();
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
