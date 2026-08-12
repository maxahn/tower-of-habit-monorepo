import { testQueue } from "./queues/test-queue";

console.log("worker: ok");

await testQueue.add("ping", { message: "hello from test job" });
