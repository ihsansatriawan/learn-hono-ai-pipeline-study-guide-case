import z from "zod";

export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const LANGUAGES = ["id", "en"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const SOURCE_TEXT_MIN = 500;
export const SOURCE_TEXT_MAX = 20_000;

/** Batas jumlah — lihat CONTEXT.md "Grounding": jumlah mengikuti kepadatan materi. */
export const MIN_CONCEPTS = 2;
export const MAX_CONCEPTS = 12;
export const MAX_QUESTIONS_PER_CONCEPT = 3;

export const StudyRequestSchema = z.object({
  sourceText: z.string().trim().min(SOURCE_TEXT_MIN).max(SOURCE_TEXT_MAX),
  level: z.enum(LEVELS),
  language: z.enum(LANGUAGES),
});
export type StudyRequest = z.infer<typeof StudyRequestSchema>;

/**
 * Skema keluaran langkah 1 sengaja TIDAK memakai .min(2).
 *
 * Kalau batas bawah ditegakkan di sini, materi yang memang tidak mengajarkan
 * apa-apa akan gagal sebagai error validasi skema — yang digolongkan transient
 * dan diulang tiga kali dengan sia-sia. Kita ingin materi tipis menjadi
 * UnprocessableSourceError yang permanen, jadi jumlahnya diperiksa di kode.
 */
export const ExtractedConceptsSchema = z.object({
  concepts: z.array(
    z.object({
      slug: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().min(1),
    }),
  ),
});

export const ExplainedConceptsSchema = z.object({
  explanations: z.array(
    z.object({
      slug: z.string().min(1),
      explanation: z.string().min(1),
      whyItMatters: z.string().min(1),
    }),
  ),
});

export const GeneratedQuizSchema = z.object({
  questions: z.array(
    z.object({
      slug: z.string().min(1),
      question: z.string().min(1),
      answer: z.string().min(1),
      difficulty: z.enum(DIFFICULTIES),
    }),
  ),
});

/** Bentuk akhir yang keluar dari langkah 4 dan masuk ke database. */
export type AssembledConcept = {
  slug: string;
  order: number;
  title: string;
  explanation: string;
  whyItMatters: string;
};

export type AssembledQuestion = {
  slug: string;
  question: string;
  answer: string;
  difficulty: (typeof DIFFICULTIES)[number];
};

export type StudyGuide = {
  concepts: AssembledConcept[];
  questions: AssembledQuestion[];
};
