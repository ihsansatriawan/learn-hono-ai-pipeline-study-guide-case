import { generateCompletion } from "@anvia/core";
import { Pipeline } from "@anvia/core/pipeline";
import { model } from "../llm/models";
import { MisalignedStepOutputError, UnprocessableSourceError } from "../errors";
import {
  explainInstructions,
  extractInstructions,
  quizInstructions,
  sourceBlock,
} from "./prompts";
import {
  ExplainedConceptsSchema,
  ExtractedConceptsSchema,
  GeneratedQuizSchema,
  MAX_CONCEPTS,
  MAX_QUESTIONS_PER_CONCEPT,
  MIN_CONCEPTS,
  StudyRequestSchema,
  type AssembledConcept,
  type AssembledQuestion,
  type StudyGuide,
  type StudyRequest,
} from "./schema";

type ExtractedConcept = { slug: string; title: string; summary: string };

/**
 * Slug adalah tali pengikat antar langkah (docs/adr/0003), jadi ia harus stabil
 * dan unik walau model mengembalikannya berantakan atau kembar.
 */
function normalizeSlugs(concepts: ExtractedConcept[]): ExtractedConcept[] {
  const taken = new Set<string>();

  return concepts.map((concept, index) => {
    const base =
      concept.slug
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || `konsep-${index + 1}`;

    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(slug);

    return { ...concept, slug };
  });
}

function formatConceptList(concepts: ExtractedConcept[]): string {
  return concepts
    .map((c, i) => `${i + 1}. slug: ${c.slug}\n   title: ${c.title}\n   summary: ${c.summary}`)
    .join("\n");
}

export const studyGuidePipeline = new Pipeline({
  id: "study-guide",
  name: "Study Guide",
  description:
    "Ubah materi belajar mentah menjadi konsep berpenjelasan dan soal pemeriksaan pemahaman.",
  inputSchema: StudyRequestSchema,
})
  .step({
    id: "extract-concepts",
    name: "Ekstrak konsep",
    run: async ({ input }) => {
      const request = input as StudyRequest;

      const result = await generateCompletion({
        model,
        instructions: extractInstructions(request),
        prompt: sourceBlock(request.sourceText),
        outputSchema: ExtractedConceptsSchema,
      });

      const concepts = normalizeSlugs(result.output.concepts).slice(0, MAX_CONCEPTS);

      // Materi tipis adalah kegagalan permanen, bukan bahan percobaan ulang.
      if (concepts.length < MIN_CONCEPTS) {
        throw new UnprocessableSourceError(
          `Materi hanya menghasilkan ${concepts.length} konsep; minimal ${MIN_CONCEPTS} diperlukan untuk membentuk study guide.`,
        );
      }

      console.log(`[extract-concepts] ${concepts.length} konsep: ${concepts.map((c) => c.slug).join(", ")}`);

      return { request, concepts };
    },
  })
  .step({
    id: "explain-concepts",
    name: "Jelaskan konsep",
    run: async ({ input }) => {
      const { request, concepts } = input as { request: StudyRequest; concepts: ExtractedConcept[] };

      const result = await generateCompletion({
        model,
        instructions: explainInstructions(request),
        prompt: [
          sourceBlock(request.sourceText),
          "<concepts>",
          formatConceptList(concepts),
          "</concepts>",
        ].join("\n"),
        outputSchema: ExplainedConceptsSchema,
      });

      console.log(`[explain-concepts] ${result.output.explanations.length} penjelasan`);

      return { request, concepts, explanations: result.output.explanations };
    },
  })
  .step({
    id: "generate-quiz",
    name: "Buat soal",
    run: async ({ input }) => {
      const { request, concepts, explanations } = input as {
        request: StudyRequest;
        concepts: ExtractedConcept[];
        explanations: { slug: string; explanation: string; whyItMatters: string }[];
      };

      const explained = explanations
        .map((e) => `slug: ${e.slug}\nexplanation: ${e.explanation}\nwhyItMatters: ${e.whyItMatters}`)
        .join("\n\n");

      const result = await generateCompletion({
        model,
        instructions: quizInstructions(request),
        prompt: `<explained-concepts>\n${explained}\n</explained-concepts>`,
        outputSchema: GeneratedQuizSchema,
      });

      console.log(`[generate-quiz] ${result.output.questions.length} soal`);

      return { request, concepts, explanations, questions: result.output.questions };
    },
  })
  .step({
    id: "assemble-guide",
    name: "Rakit guide",
    // Langkah deterministik: tidak memanggil model sama sekali. Di sinilah
    // seluruh aturan kelengkapan ditegakkan (docs/adr/0003).
    run: async ({ input }) => {
      const { concepts, explanations, questions } = input as {
        concepts: ExtractedConcept[];
        explanations: { slug: string; explanation: string; whyItMatters: string }[];
        questions: AssembledQuestion[];
      };

      const knownSlugs = new Set(concepts.map((c) => c.slug));

      // Slug asing = model menghasilkan sesuatu yang tidak diminta; buang saja.
      const explanationBySlug = new Map<string, (typeof explanations)[number]>();
      for (const explanation of explanations) {
        if (knownSlugs.has(explanation.slug) && !explanationBySlug.has(explanation.slug)) {
          explanationBySlug.set(explanation.slug, explanation);
        }
      }

      const missingExplanations = concepts
        .filter((c) => !explanationBySlug.has(c.slug))
        .map((c) => c.slug);

      // Konsep tanpa penjelasan = model meleset; transient, layak diulang.
      if (missingExplanations.length > 0) {
        throw new MisalignedStepOutputError(
          `Penjelasan hilang untuk konsep: ${missingExplanations.join(", ")}`,
        );
      }

      const assembledConcepts: AssembledConcept[] = concepts.map((concept, index) => {
        const explanation = explanationBySlug.get(concept.slug)!;
        return {
          slug: concept.slug,
          order: index + 1,
          title: concept.title,
          explanation: explanation.explanation,
          whyItMatters: explanation.whyItMatters,
        };
      });

      const questionsBySlug = new Map<string, AssembledQuestion[]>();
      for (const question of questions) {
        if (!knownSlugs.has(question.slug)) continue;
        const bucket = questionsBySlug.get(question.slug) ?? [];
        if (bucket.length >= MAX_QUESTIONS_PER_CONCEPT) continue;
        bucket.push(question);
        questionsBySlug.set(question.slug, bucket);
      }

      const conceptsWithoutQuestions = assembledConcepts
        .filter((c) => (questionsBySlug.get(c.slug) ?? []).length === 0)
        .map((c) => c.slug);

      if (conceptsWithoutQuestions.length > 0) {
        throw new MisalignedStepOutputError(
          `Soal hilang untuk konsep: ${conceptsWithoutQuestions.join(", ")}`,
        );
      }

      // Urutkan soal mengikuti urutan belajar konsepnya.
      const assembledQuestions = assembledConcepts.flatMap(
        (concept) => questionsBySlug.get(concept.slug) ?? [],
      );

      console.log(
        `[assemble-guide] ${assembledConcepts.length} konsep, ${assembledQuestions.length} soal`,
      );

      return {
        concepts: assembledConcepts,
        questions: assembledQuestions,
      } satisfies StudyGuide;
    },
  });

export async function generateStudyGuide(request: StudyRequest): Promise<StudyGuide> {
  const result = await studyGuidePipeline.run({ input: request });
  return result.output as StudyGuide;
}
