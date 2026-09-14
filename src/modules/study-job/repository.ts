import { randomUUID } from "node:crypto";
import { db } from "../../utils/db";
import { StudyJobAlreadyFinalError } from "../../errors";
import type { StudyGuide } from "../../pipeline/schema";
import type { CreateStudyJobInput } from "./schema";

export type ConceptRow = {
  id: string;
  studyJobId: string;
  slug: string;
  order: number;
  title: string;
  explanation: string;
  whyItMatters: string;
};

export type QuestionRow = {
  id: string;
  studyJobId: string;
  conceptId: string;
  question: string;
  answer: string;
  difficulty: "easy" | "medium" | "hard";
};

export async function createStudyJob(input: CreateStudyJobInput) {
  return db.orm.public.StudyJob.create({
    sourceText: input.sourceText,
    level: input.level,
    language: input.language,
    status: "PENDING",
  });
}

export async function findStudyJob(id: string) {
  return db.orm.public.StudyJob.where((job) => job.id.eq(id)).first();
}

/**
 * "Status only moves forward" (CONTEXT.md) is enforced here, not merely hoped
 * for: every transition refuses to run against a row that is already final.
 *
 * Returns false when the row was already `COMPLETED` or `FAILED` — the worker
 * must then stop, because something else (the reconciler, a competing worker)
 * has already decided this Study Job's outcome.
 */
export async function markProcessing(id: string): Promise<boolean> {
  const updated = await db.orm.public.StudyJob.where((job) => job.id.eq(id))
    .where((job) => job.status.notIn(["COMPLETED", "FAILED"]))
    .update({ status: "PROCESSING" });

  return updated !== null;
}

/** Never overwrites a final status, so the first recorded reason is the one that survives. */
export async function markFailed(id: string, reason: string): Promise<boolean> {
  const updated = await db.orm.public.StudyJob.where((job) => job.id.eq(id))
    .where((job) => job.status.notIn(["COMPLETED", "FAILED"]))
    .update({
      status: "FAILED",
      failureReason: reason.slice(0, 500),
    });

  return updated !== null;
}

/**
 * Study Jobs the reconciler should ask Redis about — see docs/adr/0006.
 * `olderThan` only decides when a row is worth a question; it never decides the
 * row's fate. The batch cap keeps one sweep bounded after a long outage.
 */
export async function findStaleStudyJobs(
  status: "PENDING" | "PROCESSING",
  olderThan: Temporal.Instant,
  limit: number,
) {
  return db.orm.public.StudyJob.where((job) => job.status.eq(status))
    .where((job) => job.createdAt.lt(olderThan))
    .orderBy((job) => job.createdAt.asc())
    .limit(limit)
    .all();
}

/**
 * Write the whole Study Guide in a single transaction — see docs/adr/0002.
 * Concept ids are generated here (rather than read back from the insert) so
 * questions can point at their concept without depending on the order of the
 * returned rows.
 */
export async function saveStudyGuide(studyJobId: string, guide: StudyGuide) {
  const conceptRows: ConceptRow[] = guide.concepts.map((concept) => ({
    id: randomUUID(),
    studyJobId,
    slug: concept.slug,
    order: concept.order,
    title: concept.title,
    explanation: concept.explanation,
    whyItMatters: concept.whyItMatters,
  }));

  const conceptIdBySlug = new Map(conceptRows.map((row) => [row.slug, row.id]));

  const questionRows: QuestionRow[] = guide.questions.map((question) => ({
    id: randomUUID(),
    studyJobId,
    conceptId: conceptIdBySlug.get(question.slug)!,
    question: question.question,
    answer: question.answer,
    difficulty: question.difficulty,
  }));

  await db.transaction(async (tx) => {
    await tx.orm.public.Concept.createAll(conceptRows);
    await tx.orm.public.QuizQuestion.createAll(questionRows);

    const updated = await tx.orm.public.StudyJob.where((job) => job.id.eq(studyJobId))
      .where((job) => job.status.neq("FAILED"))
      .update({
        status: "COMPLETED",
        completedAt: Temporal.Now.instant(),
      });

    // The reconciler can close a Study Job whose worker turns out to still be
    // alive (docs/adr/0006). Throwing rolls the concepts and questions back
    // with the status, so a `FAILED` job is never left owning a Study Guide.
    if (updated === null) {
      throw new StudyJobAlreadyFinalError(
        `Study job ${studyJobId} was already FAILED when the guide was ready; nothing was stored.`,
      );
    }
  });
}

export async function listStudyJobs(
  limit: number,
  cursor?: { createdAt: Temporal.Instant; id: string },
) {
  const base = db.orm.public.StudyJob.orderBy([
    (job) => job.createdAt.desc(),
    (job) => job.id.desc(),
  ]);

  const page = cursor ? base.cursor({ createdAt: cursor.createdAt, id: cursor.id }) : base;

  return page.limit(limit).all();
}

/** Load concepts + questions for a set of jobs at once (two queries, not N+1). */
export async function loadGuides(studyJobIds: string[]) {
  if (studyJobIds.length === 0) {
    return { concepts: [] as ConceptRow[], questions: [] as QuestionRow[] };
  }

  const [concepts, questions] = await Promise.all([
    db.orm.public.Concept.where((concept) => concept.studyJobId.in(studyJobIds))
      .orderBy((concept) => concept.order.asc())
      .all(),
    db.orm.public.QuizQuestion.where((question) => question.studyJobId.in(studyJobIds)).all(),
  ]);

  return { concepts, questions };
}
