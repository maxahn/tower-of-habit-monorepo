import { Queue, Worker } from "bullmq";
import { connection } from "../redis";

export const TEST_QUEUE_NAME = "test";

export const testQueue = new Queue(TEST_QUEUE_NAME, { connection });

export const testWorker = new Worker(
  TEST_QUEUE_NAME,
  async (job) => {
    console.log(`processing job ${job.id}:`, job.data);
    return { ok: true };
  },
  { connection },
);

testWorker.on("completed", (job) => {
  console.log(`job ${job.id} completed`);
});

testWorker.on("failed", (job, err) => {
  console.error(`job ${job?.id} failed:`, err);
});
