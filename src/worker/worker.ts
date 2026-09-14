import { Worker } from "bullmq";
import { QUEUE_NAME, workerConnection } from "./config";
import type { StudyGuideJobData } from "./queue";
import { generateStudyGuide } from "../pipeline/study-guide-pipeline";
import { describeFailure, isPermanentFailure } from "../errors";
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

    console.log(`\n[worker] Study job ${studyJobId} — percobaan ${attempt}/${maxAttempts}`);

    const studyJob = await findStudyJob(studyJobId);
    if (!studyJob) {
      // Tidak ada baris untuk ditandai gagal; mengulang tidak akan memunculkannya.
      console.error(`[worker] Study job ${studyJobId} tidak ada di database; job dibuang.`);
      return;
    }

    // COMPLETED dan FAILED bersifat final (CONTEXT.md, "Status Study Job").
    // FAILED bisa terjadi sebelum worker menyentuh job ini: API menandainya
    // begitu pengantrean melewati batas waktu, dan perintah add yang terlambat
    // masih bisa tiba di sini setelahnya.
    if (studyJob.status === "COMPLETED" || studyJob.status === "FAILED") {
      console.log(`[worker] Study job ${studyJobId} sudah ${studyJob.status}; tidak dikerjakan.`);
      return;
    }

    await markProcessing(studyJobId);

    try {
      const guide = await generateStudyGuide({
        sourceText: studyJob.sourceText,
        level: studyJob.level,
        language: studyJob.language,
      });

      // Satu transaksi: konsep, soal, dan status COMPLETED (docs/adr/0002).
      await saveStudyGuide(studyJobId, guide);

      console.log(
        `[worker] Study job ${studyJobId} COMPLETED — ${guide.concepts.length} konsep, ${guide.questions.length} soal.`,
      );
    } catch (error) {
      const permanent = isPermanentFailure(error);
      const lastAttempt = attempt >= maxAttempts;
      const reason = describeFailure(error);

      if (permanent || lastAttempt) {
        await markFailed(studyJobId, reason);
        console.error(
          `[worker] Study job ${studyJobId} FAILED (${permanent ? "permanen" : "transient, percobaan habis"}): ${reason}`,
        );

        // Kegagalan permanen tidak dilempar: percobaan ulang tidak akan menolong.
        if (permanent) return;
      } else {
        console.warn(`[worker] Study job ${studyJobId} gagal transient, akan diulang: ${reason}`);
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
  `[worker] Menunggu job di "${QUEUE_NAME}" (redis ${env.REDIS_HOST}:${env.REDIS_PORT}), model ${env.MODEL_ID}.`,
);

worker.on("error", (error) => {
  console.error("[worker] Error koneksi/worker:", error);
});
