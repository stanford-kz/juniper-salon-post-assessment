import { NativeConnection, Worker } from '@temporalio/worker';
import { sendOffer } from './activities';
async function run(): Promise<void> {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  try {
    const worker = await Worker.create({ connection, namespace: 'default', taskQueue: 'juniper-waitlist', workflowsPath: require.resolve('./workflows'), activities: { sendOffer }, maxHeartbeatThrottleInterval: '100 milliseconds' });
    console.log('Worker is polling the juniper-waitlist task queue.');
    await worker.run();
  } finally { await connection.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
