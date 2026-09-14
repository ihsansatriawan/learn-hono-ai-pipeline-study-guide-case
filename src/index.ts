import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./config/env";
import { queue } from "./worker/queue";
import { studyJobRouter } from "./modules/study-job/router";

const app = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/jobs", studyJobRouter);

app.notFound((c) => c.json({ error: "Route tidak ditemukan." }, 404));

app.onError((error, c) => {
  console.error("[api] Unhandled error:", error);
  return c.json({ error: "Terjadi kesalahan internal." }, 500);
});

/**
 * Koneksi producer memakai enableOfflineQueue: false, jadi perintah yang
 * dikirim sebelum koneksi siap akan ditolak. Hangatkan koneksinya lebih dulu
 * supaya permintaan pertama tidak gagal hanya karena datang terlalu cepat.
 *
 * Redis yang mati TIDAK menghalangi server menyala: pembacaan (GET /jobs) tetap
 * berguna, dan POST akan menolak dengan jujur lewat 503.
 */
async function warmUpQueue() {
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 5_000).unref(),
  );

  try {
    const outcome = await Promise.race([queue.waitUntilReady().then(() => "ready" as const), timeout]);
    if (outcome === "timeout") {
      console.warn("[api] Redis belum siap setelah 5s; POST /jobs akan membalas 503 sampai tersambung.");
    }
  } catch (error) {
    console.warn(
      `[api] Tidak bisa menyambung ke Redis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await warmUpQueue();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api] Berjalan di http://localhost:${info.port}`);
});
