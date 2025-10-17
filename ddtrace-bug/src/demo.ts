import "./tracer";

import QueueService, {GetResponse} from "./queue_service";
async function demo() {
  const queueService = QueueService.Instance;
  async function run(queueName:string) {
    return await queueService.subscribe(
      queueName,
      async (_message, identifier) => {
        queueService.acknowledge(identifier);
      });
  }
  try {
    console.log('=== AMQPLIB 0.10.9 Demo ===\n');
    const runners:Promise<() => void>[] = [
     run("audit-log"),
     run("backfill-checkin"),
     run("debit-card"),
     run("enrollment"),
     run("glucose-detection"),
     run("blood-pressure-bedrock"),
     run("blood-pressure-google"),
     run("blood-pressure-roboflow"),
     run("pill-detection"),
     run("program_update_notifications"),
     run("reindex-person"),
     run("rest-notify"),
     run("result-consumer"),
     run("rx-refill-listener"),
     run("sync-user"),
     run("task-table-listener"),
     run("upload-producer"),
     run("vender-defer-customerio"),
     run("vender-defer-dead-letter"),
     run("vender-defer-freshpaint"),
     run("vender-defer-mixpanel"),
     run("vender-defer-salesforce"),
     run("vender-defer-salesforce-identify"),
     run("update-prospect"),
     run("reopen-prospect"),
     run("prospect-result"),
     run("close-prospect"),
     run("create-prospect"),
     run("cleanup-orphan-test-accounts"),
     run("wellth-event"), //DEPRECATED DO NOT USE
     run("wellth-day"),
     run("member-activation"),
     run("payment-success"),
     run("check-in"),
     run("io-outreach-cycle"),
     run("email-queue"),
     run("fax-queue")
    ];

    await Promise.all(runners);
    let getMessage: GetResponse | false;
    while ((getMessage = await queueService.get("vendor-dead-letter"))) {
      const message: Buffer = getMessage.message;
      console.log(message);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('\n=== Demo completed ===');

  } catch (error) {
    console.error('Demo failed:', error);
  } finally {
    // await producer.close();
    // await consumer.close();
    process.exit(0);
  }
}

if (require.main === module) {
  demo().catch(console.error);
}
