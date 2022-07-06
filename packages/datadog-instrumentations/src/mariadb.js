"use strict";

const { channel, addHook, AsyncResource } = require("./helpers/instrument");

const shimmer = require("../../datadog-shimmer");

const startCh = channel("apm:mariadb:query:start");
const finishCh = channel("apm:mariadb:query:finish");
const errorCh = channel("apm:mariadb:query:error");

function wrapQueryCmd(queryCmd) {
  return function (_conn, sql, _values) {
    if (!startCh.hasSubscribers) {
      return queryCmd.apply(this, arguments);
    }

    const asyncResource = new AsyncResource("bound-anonymous-fn");

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql });

      try {
        const promise = queryCmd.apply(this, arguments);

        promise.then(
          asyncResource.bind(() => finishCh.publish()),
          asyncResource.bind((e) => {
            errorCh.publish(e);
            finishCh.publish();
          })
        );

        return promise;
      } catch (e) {
        errorCh.publish(e);
        finishCh.publish();
        throw e;
      }
    });
  };
}

function wrapQueryStream(queryStream) {
  return function (sql, _values) {
    if (!startCh.hasSubscribers) {
      return queryStream.apply(this, arguments);
    }

    const asyncResource = new AsyncResource("bound-anonymous-fn");

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql });

      try {
        const stream = queryStream.apply(this, arguments);

        stream
          .once("end", () => finishCh.publish())
          .once("error", (e) => {
            errorCh.publish(e);
            finishCh.publish();
          });

        return stream;
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
    file: "lib/connection-promise.js",
    versions: [">=3"],
  },
  (ConnectionPromise) => {
    shimmer.wrap(ConnectionPromise, "_QUERY_CMD", wrapQueryCmd);
    shimmer.wrap(ConnectionPromise.prototype, "queryStream", wrapQueryStream);

    return ConnectionPromise;
  }
);
