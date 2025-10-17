import {
  connect,
  AmqpConnectionManager,
  ChannelWrapper,
  SetupFunc,
} from "amqp-connection-manager";
import { ConfirmChannel, ConsumeMessage, Message, Replies } from "amqplib";
import assert from "assert";

const MAX_PRIORITY = 10;
export const LOW_PRIORITY = 0;
export const HIGH_PRIORITY = 10;

type SubscribeCallback = (
  message: string,
  identifier: number,
  redelivered: boolean,
) => Promise<void>;

export interface GetResponse {
  message: Buffer;
  identifier: number;
  redelivered: boolean;
}

const QUEUE_DELIVERY_MODE = 2;
const QUEUE_NO_ACKNOWLEDGE = false;
const DELAY_EXCHANGE_NAME = "scheduler";

export default class QueueService {
  private static instance?: QueueService;

  private _channel?: ConfirmChannel;
  private _channelWrapper?: ChannelWrapper;
  private _connectionMgr?: AmqpConnectionManager;

  private messages = new Map<number, Message>();

  private async _createQueue(queueName: string, delayExchange = false) {
    const channelWrapper = this.getChannelWrapper();
    await channelWrapper.waitForConnect();
    if (this._channel) {
      await this._bindChannel(this._channel, queueName, delayExchange);
    } else {
      throw Error("Channel not available");
    }
  }

  private async _bindChannel(
    channel: ConfirmChannel,
    queueName: string,
    delayExchange: boolean,
  ) {
    if (delayExchange) {
      await channel.assertExchange(DELAY_EXCHANGE_NAME, "x-delayed-message", {
        durable: true,
        arguments: { "x-delayed-type": "direct" },
      });
    }
    await channel.assertQueue(queueName, {
      durable: true,
      exclusive: false,
      autoDelete: false,
      // If priority queues are desired, we recommend using between 1 and 10.
      // Currently, using more priorities will consume more CPU resources by using more Erlang processes.
      // Runtime scheduling would also be affected.
      maxPriority: MAX_PRIORITY,
    });
    if (delayExchange) {
      await channel.bindQueue(queueName, DELAY_EXCHANGE_NAME, "");
    }
  }

  public static get Instance(): QueueService {
    if (this.instance) {
      return this.instance;
    }
    this.instance = new this();
    return this.instance;
  }

  public static async sleepUntilEmpty(queueName: string): Promise<void> {
    let queueStatus: Replies.AssertQueue | undefined;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      queueStatus = await this.Instance.checkQueue(queueName);
      if (queueStatus && queueStatus.messageCount > 0) {
        console.log(`Queue ${queueName} has ${queueStatus.messageCount} messages`);
      }
    } while (queueStatus && queueStatus.messageCount > 0);
  }

  public getChannelWrapper(): ChannelWrapper {
    if (!this._channelWrapper) {
      console.log(__filename, "connecting to rabbitmq...");
      this._connectionMgr = connect(['amqp://localhost']);
      this._channelWrapper = this._connectionMgr.createChannel({
        json: false,
        setup: async (channel: ConfirmChannel): Promise<void> => {
          this.messages = new Map(); // must discard prev messages on a fresh channel, it seems
          this._channel = channel;
          // https://medium.com/@joor.loohuis/about-the-prefetch-count-in-rabbitmq-5f2f5611063b
          // For proper round-robin message distribution with more than one consumer, set the prefetch count to 1.
          // At the price of more overhead in message transfer, messages are evenly distributed over all consumers,
          // requeueing is almost instantly after a consumer fails, and the memory load for both the consumers and
          // RabbitMQ is as small as possible. Scaling to higher message volumes while preserving quality of service
          // can then be done by adding more consumers.

          // https://www.rabbitmq.com/consumer-prefetch.html
          // global:false => applied separately to each new consumer on the channel
          await channel.prefetch(1, false);
        },
      });
      this._channelWrapper.on("return", (message: Message) => {
        console.error(
          __filename,
          `Unable to route message to ${message.fields.routingKey}`,
          message,
        );
      });
      this._channelWrapper.on("error", (err: Error, info: { name: string }) => {
        console.error(__filename, `Error on channel ${info.name}`, {}, err);
      });
      // turn off node warning
      this._channelWrapper.setMaxListeners(0);
    }
    return this._channelWrapper;
  }

  // -- public --
  public async send(
    queueName: string,
    buffer: Buffer,
    delayMillis = 0,
    priority = LOW_PRIORITY, // the higher the number the higher the priority
  ): Promise<void> {
    assert(queueName);
    try {
      const delayExchange = delayMillis > 0;
      await this._createQueue(queueName, delayExchange);
      const channelWrapper = this.getChannelWrapper();
      if (delayExchange) {
        await channelWrapper.publish(DELAY_EXCHANGE_NAME, "", buffer, {
          persistent: true,
          deliveryMode: QUEUE_DELIVERY_MODE,
          headers: { "x-delay": delayMillis },
          priority,
        });
      } else {
        await channelWrapper.sendToQueue(queueName, buffer, {
          persistent: true,
          deliveryMode: QUEUE_DELIVERY_MODE,
          mandatory: true,
          priority,
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(__filename, "Error sending message", { queue_name: queueName }, err);
        throw err;
      }
      throw err;
    }
  }

  // -- public --
  public async subscribe(
    queueName: string,
    callback?: SubscribeCallback,
  ): Promise<() => Promise<void>> {
    assert(queueName);
    let consumerTag: string;
    let setup: SetupFunc;
    let queue: ConfirmChannel;
    await this.getChannelWrapper().addSetup(
      (setup = async (channel: ConfirmChannel): Promise<void> => {
        try {
          console.log(__filename, `Connected Queue ${queueName}`);
          queue = channel;
          await channel.assertQueue(queueName, {
            durable: true,
            exclusive: false,
            autoDelete: false,
            // If priority queues are desired, we recommend using between 1 and 10.
            // Currently, using more priorities will consume more CPU resources by using more Erlang processes.
            // Runtime scheduling would also be affected.
            maxPriority: MAX_PRIORITY,
          });
          const consumer = await channel.consume(
            queueName,
            (rmqMessage: ConsumeMessage | null) => {
              if (rmqMessage !== null) {
                const {
                  content,
                  fields: { deliveryTag, redelivered },
                } = rmqMessage;

                assert(
                  !this.messages.has(deliveryTag),
                  "assert(!this.messages[deliveryTag]) is truthy",
                );
                this.messages.set(deliveryTag, rmqMessage);
                const message = content.toString();

                if (callback) {
                  callback(message, deliveryTag, redelivered).catch((e: unknown) => {
                    console.error("", "error", null, e);
                  });
                }
              }
            },
            { noAck: QUEUE_NO_ACKNOWLEDGE },
          );
          consumerTag = consumer.consumerTag;
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error(
              __filename,
              "Error subscribing to queue",
              { queue_name: queueName },
              err,
            );
            throw err;
          }
          throw err;
        }
      }),
    );
    return async (): Promise<void> => {
      return queue
        .cancel(consumerTag)
        .then(() => {
          return this.getChannelWrapper().removeSetup(setup);
        })
        .catch((err: unknown) => {
          console.error(
            __filename,
            "Error unsubscribing to queue",
            { queue_name: queueName },
            err,
          );
        });
    };
  }

  public acknowledge(identifier: number): void {
    const message: Message | undefined = this.messages.get(identifier);
    if (message) {
      try {
        this.getChannelWrapper().ack(message);
        this.messages.delete(identifier);
      } catch (err: unknown) {
        if (err instanceof Error) {
          const errorMessage = `Error acknowledging ${JSON.stringify(message)}: ${err.toString()}`;
          console.error(__filename, "Error acknowledging", { message }, err);
          throw Error(errorMessage);
        }
        throw err;
      }
    }
  }

  // Reject and requeue a message
  public fail(identifier: number): void {
    const message: Message | undefined = this.messages.get(identifier);
    if (message) {
      try {
        const channel = this._channel;
        channel?.reject(message, true);
      } catch (err: unknown) {
        if (err instanceof Error) {
          const errorMessage = `Error failing ${JSON.stringify(message)}: ${err.toString()}`;
          console.error(__filename, "Error failing", { message }, err);
          throw Error(errorMessage);
        }
        throw err;
      }
    }
    this.messages.delete(identifier);
  }

  // Reject a message. No requeueing
  public reject(identifier: number): void {
    const message: Message | undefined = this.messages.get(identifier);
    if (message) {
      try {
        const channel = this._channel;
        channel?.reject(message, false);
        this.messages.delete(identifier);
      } catch (err: unknown) {
        if (err instanceof Error) {
          const errorMessage = `Error rejecting ${JSON.stringify(message)}: ${err.toString()}`;
          console.error(__filename, "Error rejecting", { message }, err);
          throw Error(errorMessage);
        }
        throw err;
      }
    }
  }

  public async purge(queueName: string): Promise<void> {
    try {
      await this.getChannelWrapper().waitForConnect();
      const channel = this._channel;
      await channel?.purgeQueue(queueName);
      // if (queueName == QUEUE_NAME.SCHEDULER) {
      //   // these queued items are living in the exchange until de-queued
      //   await channel.deleteExchange(DELAY_EXCHANGE_NAME);
      // }
    } catch (err: unknown) {
      if (err instanceof Error) {
        const errorMessage = `Error purging queue ${queueName}: ${err.toString()}`;
        console.error(__filename, "Error purging queue", { queue_name: queueName }, err);
        throw Error(errorMessage);
      }
      throw err;
    }
  }

  public async deleteQueue(
    queueName: string,
  ): Promise<Replies.PurgeQueue | undefined> {
    try {
      await this.getChannelWrapper().waitForConnect();
      const channel = this._channel;
      return await channel?.deleteQueue(queueName);
    } catch (err: unknown) {
      if (err instanceof Error) {
        const errorMessage = `Error deleting queue ${queueName}: ${err.toString()}`;
        console.error(__filename, "Error deleting queue", { queue_name: queueName }, err);
        throw Error(errorMessage);
      }
      throw err;
    }
  }

  public async get(
    queueName: string,
    delayExchange = false,
  ): Promise<GetResponse | false> {
    this.getChannelWrapper();
    try {
      await this._createQueue(queueName, delayExchange);
      const channel = this._channel;
      const rmqMessage = await channel?.get(queueName);
      if (!rmqMessage) {
        return false;
      }

      const {
        content,
        fields: { deliveryTag, redelivered },
      } = rmqMessage;
      assert(
        !this.messages.get(deliveryTag),
        "assert(!this.messages[deliveryTag]) is truthy",
      );
      this.messages.set(deliveryTag, rmqMessage);
      return {
        message: content,
        identifier: deliveryTag,
        redelivered: redelivered,
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const errorMessage = `Error getting message from ${queueName}: ${err.toString()}`;
        console.error(__filename, "Error getting message", { queue_name: queueName }, err);
        throw Error(errorMessage);
      }
      throw err;
    }
  }

  public async checkQueue(
    queueName: string,
    delayExchange = false,
  ): Promise<Replies.AssertQueue | undefined> {
    try {
      await this._createQueue(queueName, delayExchange);
      const channel = this._channel;
      return await channel?.checkQueue(queueName);
    } catch (err: unknown) {
      if (err instanceof Error) {
        const errorMessage = `Error checking queue ${queueName}: ${err.toString()}`;
        console.error(__filename, "Error checking queue", { queue_name: queueName }, err);
        throw Error(errorMessage);
      }
      throw err;
    }
  }

  public unpublishedCount(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-return
      return this._channel?.pending.length ?? 0;
    } catch (err: unknown) {
      console.error(__filename, "Error queueLength()", null, err);
    }
    return -1;
  }

  // -- public --
  public async disconnect(): Promise<void> {
    try {
      await this._channelWrapper?.close();
      await this._connectionMgr?.close();
      delete this._channelWrapper;
      delete this._connectionMgr;
    } catch (err: unknown) {
      if (err instanceof Error) {
        const errorMessage = `Error disconnecting: ${err.toString()}`;
        console.error(__filename, "Error disconnecting", null, err);
        throw Error(errorMessage);
      }
      throw err;
    }
  }
}
