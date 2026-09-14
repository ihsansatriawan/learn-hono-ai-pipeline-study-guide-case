import { randomUUID } from "node:crypto";
import { db } from "../../utils/db";
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

export async function markProcessing(id: string) {
  await db.orm.public.StudyJob.where((job) => job.id.eq(id)).update({ status: "PROCESSING" });
}

export async function markFailed(id: string, reason: string) {
  await db.orm.public.StudyJob.where((job) => job.id.eq(id)).update({
    status: "FAILED",
    failureReason: reason.slice(0, 500),
  });
}

/**
 * Tulis seluruh Study Guide dalam satu transaksi — lihat docs/adr/0002.
 * Id konsep dibuat di sini (bukan dibaca dari hasil insert) supaya soal bisa
 * menunjuk konsepnya tanpa bergantung pada urutan baris yang dikembalikan.
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
    await tx.orm.public.StudyJob.where((job) => job.id.eq(studyJobId)).update({
      status: "COMPLETED",
      completedAt: Temporal.Now.instant(),
    });
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

/** Muat konsep + soal untuk sekumpulan job sekaligus (dua query, bukan N+1). */
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
