import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./config/env";
import { queue } from "./worker/queue";
import { studyJobRouter } from "./modules/study-job/router";

const app = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/jobs", studyJobRouter);

app.notFound((c) => c.json({ error: "Route not found." }, 404));

app.onError((error, c) => {
  console.error("[api] Unhandled error:", error);
  return c.json({ error: "An internal error occurred." }, 500);
});

/**
 * The producer connection uses enableOfflineQueue: false, so commands sent
 * before the connection is ready are rejected. Warm the connection up first so
 * the very first request does not fail merely for arriving too early.
 *
 * A dead Redis does NOT stop the server from starting: reads (GET /jobs) stay
 * useful, and POST rejects honestly with a 503.
 */
async function warmUpQueue() {
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 5_000).unref(),
  );

  try {
    const outcome = await Promise.race([queue.waitUntilReady().then(() => "ready" as const), timeout]);
    if (outcome === "timeout") {
      console.warn("[api] Redis not ready after 5s; POST /jobs will answer 503 until it connects.");
    }
  } catch (error) {
    console.warn(
      `[api] Could not connect to Redis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await warmUpQueue();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api] Running at http://localhost:${info.port}`);
});
