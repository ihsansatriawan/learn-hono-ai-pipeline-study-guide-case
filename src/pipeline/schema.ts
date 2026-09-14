import z from "zod";

export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const LANGUAGES = ["id", "en"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export const SOURCE_TEXT_MIN = 500;
export const SOURCE_TEXT_MAX = 20_000;

/** Count limits — see CONTEXT.md "Grounding": counts follow the density of the material. */
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
 * The step 1 output schema deliberately does NOT use .min(2).
 *
 * If the lower bound were enforced here, material that genuinely teaches
 * nothing would fail as a schema validation error — which is classified as
 * transient and retried three times for nothing. We want thin material to
 * become a permanent UnprocessableSourceError, so the count is checked in code.
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

/** The final shape that leaves step 4 and goes into the database. */
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
