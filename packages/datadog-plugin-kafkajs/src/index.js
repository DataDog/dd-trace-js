"use strict";

function createWrapConsumer(tracer, config) {
  return function wrapProcessEachMessage(Consumer) {
    return function processEachMessageWithTrace() {
      const consumer = Consumer.apply(this, arguments);
      const run = consumer.run;

      consumer.run = async function ({eachMessage, ...args}) {
        // return the promise
        return run({
          eachMessage: tracer.wrap("kafka", {}, eachMessage),
          args
        });
      };

      return consumer;
    };
  };
}

module.exports = [
  {
    name: "kafkajs",
    versions: [">=1.2"],
    patch({ Kafka }, tracer, config) {
      this.wrap(
        Kafka.prototype,
        "consumer",
        createWrapConsumer(tracer, config)
      );
    },
  },
];
