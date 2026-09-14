import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { enqueueStudyGuideJob } from "../../worker/queue";
import { CreateStudyJobSchema, ListStudyJobsSchema } from "./schema";
import {
  createStudyJob,
  findStudyJob,
  listStudyJobs,
  loadGuides,
  markFailed,
} from "./repository";
import {
  decodeCursor,
  encodeCursor,
  groupByStudyJob,
  presentStudyJob,
} from "./presenter";

export const studyJobRouter = new Hono()
  .post("/", zValidator("json", CreateStudyJobSchema), async (c) => {
    const body = c.req.valid("json");

    const job = await createStudyJob(body);

    // Baris sudah tersimpan; kalau antrean menolak, jangan balas 202 —
    // tidak ada yang akan mengerjakan job itu.
    try {
      await enqueueStudyGuideJob(job.id);
    } catch (error) {
      const reason = `Gagal mengantre ke Redis: ${error instanceof Error ? error.message : String(error)}`;
      await markFailed(job.id, reason);
      return c.json(
        { error: "Antrean tidak tersedia, permintaan tidak diterima.", jobId: job.id },
        503,
      );
    }

    return c.json(
      {
        job: {
          id: job.id,
          status: job.status,
          level: job.level,
          language: job.language,
          createdAt: job.createdAt,
        },
      },
      202,
    );
  })
  .get("/", zValidator("query", ListStudyJobsSchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return c.json({ error: "Cursor tidak valid." }, 400);
    }

    const jobs = await listStudyJobs(limit, decoded ?? undefined);
    const { concepts, questions } = await loadGuides(jobs.map((job) => job.id));

    const conceptsByJob = groupByStudyJob(concepts);
    const questionsByJob = groupByStudyJob(questions);

    const last = jobs.at(-1);

    return c.json({
      jobs: jobs.map((job) =>
        presentStudyJob(job, conceptsByJob.get(job.id) ?? [], questionsByJob.get(job.id) ?? []),
      ),
      nextCursor: last && jobs.length === limit ? encodeCursor(last) : null,
    });
  })
  .get("/:id", async (c) => {
    const { id } = c.req.param();

    const job = await findStudyJob(id);
    if (!job) {
      return c.json({ error: `Study job ${id} tidak ditemukan.` }, 404);
    }

    const { concepts, questions } = await loadGuides([job.id]);

    return c.json(presentStudyJob(job, concepts, questions));
  });
