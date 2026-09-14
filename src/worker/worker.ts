import { Worker } from "bullmq";
import { QUEUE_NAME, workerConnection } from "./config";
import type { StudyGuideJobData } from "./queue";
import { generateStudyGuide } from "../pipeline/study-guide-pipeline";
import { describeFailure, isPermanentFailure } from "../errors";
import { startReconciler } from "./reconciler";
import {
  findStudyJob,
  markFailed,
  markProcessing,
  saveStudyGuide,
} from "../modules/study-job/repository";
import { env } from "../config/env";

export const worker = new Worker<StudyGuideJobData>(
  QUEUE_NAME,
  async (job) => {
    const { studyJobId } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    console.log(`\n[worker] Study job ${studyJobId} — attempt ${attempt}/${maxAttempts}`);

    const studyJob = await findStudyJob(studyJobId);
    if (!studyJob) {
      // There is no row to mark as failed; retrying will not make one appear.
      console.error(`[worker] Study job ${studyJobId} is not in the database; discarding the job.`);
      return;
    }

    // COMPLETED and FAILED are final (CONTEXT.md, "Study Job status").
    // FAILED can happen before the worker ever touches this job: the API marks
    // it as soon as enqueueing times out, and a late add command can still
    // arrive here afterwards.
    if (studyJob.status === "COMPLETED" || studyJob.status === "FAILED") {
      console.log(`[worker] Study job ${studyJobId} is already ${studyJob.status}; skipping.`);
      return;
    }

    // Between the check above and this write, the reconciler may have closed the
    // job (docs/adr/0006). markProcessing refuses to move a final status, and
    // says so — that refusal is the signal to stop.
    if (!(await markProcessing(studyJobId))) {
      console.log(`[worker] Study job ${studyJobId} became final while being claimed; skipping.`);
      return;
    }

    try {
      const guide = await generateStudyGuide({
        sourceText: studyJob.sourceText,
        level: studyJob.level,
        language: studyJob.language,
      });

      // One transaction: concepts, questions, and the COMPLETED status (docs/adr/0002).
      await saveStudyGuide(studyJobId, guide);

      console.log(
        `[worker] Study job ${studyJobId} COMPLETED — ${guide.concepts.length} concepts, ${guide.questions.length} questions.`,
      );
    } catch (error) {
      const permanent = isPermanentFailure(error);
      const lastAttempt = attempt >= maxAttempts;
      const reason = describeFailure(error);

      if (permanent || lastAttempt) {
        await markFailed(studyJobId, reason);
        console.error(
          `[worker] Study job ${studyJobId} FAILED (${permanent ? "permanent" : "transient, attempts exhausted"}): ${reason}`,
        );

        // Permanent failures are not rethrown: a retry would not help.
        if (permanent) return;
      } else {
        console.warn(`[worker] Study job ${studyJobId} failed transiently, will retry: ${reason}`);
      }

      throw error;
    }
  },
  {
    connection: workerConnection,
    concurrency: 2,
  },
);

console.log(
  `[worker] Waiting for jobs on "${QUEUE_NAME}" (redis ${env.REDIS_HOST}:${env.REDIS_PORT}), model ${env.MODEL_ID}.`,
);

// Recovery is scanned from PostgreSQL, so it lives with the worker rather than
// with the API — the API is a request/response boundary and the first thing to
// be scaled horizontally. See docs/adr/0006.
startReconciler();

worker.on("error", (error) => {
  console.error("[worker] Connection/worker error:", error);
});
