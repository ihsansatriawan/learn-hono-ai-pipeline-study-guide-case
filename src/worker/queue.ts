import { Queue } from "bullmq";
import { QUEUE_NAME, queueConnection } from "./config";

export const STUDY_GUIDE_TASK = "generate-study-guide";

/** Payload antrean hanya membawa penunjuk; PostgreSQL tetap sumber kebenaran. */
export type StudyGuideJobData = { studyJobId: string };

/**
 * Batas tunggu saat mengantre. enableOfflineQueue: false saja tidak cukup:
 * kalau Redis belum pernah tersambung, BullMQ menunggu koneksi siap sebelum
 * mengirim perintah, sehingga permintaan HTTP menggantung tanpa batas.
 * Lihat ADR-0005.
 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

export const queue = new Queue<StudyGuideJobData>(QUEUE_NAME, {
  connection: queueConnection,
});

// Tanpa listener ini, kegagalan koneksi ioredis muncul sebagai unhandled error
// dan membanjiri stderr dengan stack ECONNREFUSED tiap percobaan sambung ulang.
queue.on("error", (error) => {
  console.warn(`[queue] Redis: ${error instanceof Error ? error.message : String(error)}`);
});

export async function enqueueStudyGuideJob(studyJobId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Antrean tidak merespons dalam ${ENQUEUE_TIMEOUT_MS}ms`)),
      ENQUEUE_TIMEOUT_MS,
    );
    timer.unref();
  });

  try {
    return await Promise.race([
      queue.add(
        STUDY_GUIDE_TASK,
        { studyJobId },
        {
          jobId: studyJobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
