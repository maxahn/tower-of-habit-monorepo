import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TEST_IMPORT } from "@tower-of-habit/shared";

console.log(`TEST_IMPORT=${TEST_IMPORT} successfully imported from shared`);

const app = new Hono();

app.get("/healthz", (c) => c.body(null, 204));

app.get("/evaluate", (c) => {
  const input = c.req.query("input");
  return c.json({ result: `input: ${input}` });
});

const port = Number(process.env.PORT) || 3000;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
