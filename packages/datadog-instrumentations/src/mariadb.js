"use strict";

const { channel, addHook, AsyncResource } = require("./helpers/instrument");

const shimmer = require("../../datadog-shimmer");

const startCh = channel("apm:mariadb:query:start");
const finishCh = channel("apm:mariadb:query:finish");
const errorCh = channel("apm:mariadb:query:error");

function wrapConnectionQuery(query) {
  return function (_cmdOpt, sql, _values, _resolve, _reject) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments);
    }

    const asyncResource = new AsyncResource("bound-anonymous-fn");

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql });

      try {
        const cmd = query.apply(this, arguments);

        cmd
          .once(
            "end",
            asyncResource.bind(() => finishCh.publish())
          )
          .once(
            "error",
            asyncResource.bind((e) => errorCh.publish(e))
          );

        return cmd;
      } catch (e) {
        errorCh.publish(e);
        finishCh.publish();
        throw e;
      }
    });
  };
}

addHook(
  {
    name: "mariadb",
    file: "lib/connection.js",
    versions: [">=3"],
  },
  (Connection) => {
    shimmer.wrap(Connection, "query", wrapConnectionQuery);

    return Connection;
  }
);
