import type { ConceptRow, QuestionRow } from "./repository";

type StudyJobRow = {
  id: string;
  level: string;
  language: string;
  status: string;
  failureReason: string | null;
  // Prisma 8 memetakan DateTime ke Temporal.Instant (docs/adr/0004).
  // JSON.stringify memanggil toJSON()-nya, jadi keluar sebagai string ISO 8601.
  createdAt: Temporal.Instant;
  completedAt: Temporal.Instant | null;
};

/**
 * sourceText sengaja tidak pernah dikembalikan: client baru saja mengirimnya,
 * dan ukurannya membuat polling jadi mahal.
 *
 * `guide` bernilai null persis sampai status COMPLETED — tidak ada guide
 * setengah jadi yang bisa dilihat client (docs/adr/0002).
 */
export function presentStudyJob(
  job: StudyJobRow,
  concepts: ConceptRow[],
  questions: QuestionRow[],
) {
  const isCompleted = job.status === "COMPLETED";

  return {
    id: job.id,
    status: job.status,
    level: job.level,
    language: job.language,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    failureReason: job.failureReason,
    guide: isCompleted
      ? {
          concepts: concepts
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((concept) => ({
              id: concept.id,
              order: concept.order,
              title: concept.title,
              explanation: concept.explanation,
              whyItMatters: concept.whyItMatters,
            })),
          quiz: questions.map((question) => ({
            id: question.id,
            conceptId: question.conceptId,
            question: question.question,
            answer: question.answer,
            difficulty: question.difficulty,
          })),
        }
      : null,
  };
}

export function groupByStudyJob<T extends { studyJobId: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.studyJobId) ?? [];
    bucket.push(row);
    grouped.set(row.studyJobId, bucket);
  }
  return grouped;
}

export function encodeCursor(job: { createdAt: Temporal.Instant; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: job.createdAt.toString(), id: job.id }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Temporal.Instant; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return { createdAt: Temporal.Instant.from(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}
