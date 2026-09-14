import { Queue } from "bullmq";
import { QUEUE_NAME, queueConnection } from "./config";

export const STUDY_GUIDE_TASK = "generate-study-guide";

/** The queue payload carries only a pointer; PostgreSQL remains the source of truth. */
export type StudyGuideJobData = { studyJobId: string };

/**
 * Enqueue timeout. enableOfflineQueue: false alone is not enough: if Redis has
 * never connected, BullMQ waits for the connection to be ready before sending
 * the command, so the HTTP request hangs indefinitely. See ADR-0005.
 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

export const queue = new Queue<StudyGuideJobData>(QUEUE_NAME, {
  connection: queueConnection,
});

// Without this listener, ioredis connection failures surface as unhandled
// errors and flood stderr with an ECONNREFUSED stack on every reconnect attempt.
queue.on("error", (error) => {
  console.warn(`[queue] Redis: ${error instanceof Error ? error.message : String(error)}`);
});

export async function enqueueStudyGuideJob(studyJobId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The queue did not respond within ${ENQUEUE_TIMEOUT_MS}ms`)),
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
