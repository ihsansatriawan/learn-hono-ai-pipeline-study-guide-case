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
 * The slug is the thread tying the steps together (docs/adr/0003), so it must
 * be stable and unique even when the model returns it malformed or duplicated.
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
        .slice(0, 60) || `concept-${index + 1}`;

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
    "Turn raw study material into explained concepts and comprehension questions.",
  inputSchema: StudyRequestSchema,
})
  .step({
    id: "extract-concepts",
    name: "Extract concepts",
    run: async ({ input }) => {
      const request = input as StudyRequest;

      const result = await generateCompletion({
        model,
        instructions: extractInstructions(request),
        prompt: sourceBlock(request.sourceText),
        outputSchema: ExtractedConceptsSchema,
      });

      const concepts = normalizeSlugs(result.output.concepts).slice(0, MAX_CONCEPTS);

      // Thin material is a permanent failure, not something worth retrying.
      if (concepts.length < MIN_CONCEPTS) {
        throw new UnprocessableSourceError(
          `The material yielded only ${concepts.length} concept(s); at least ${MIN_CONCEPTS} are needed to form a study guide.`,
        );
      }

      console.log(`[extract-concepts] ${concepts.length} concepts: ${concepts.map((c) => c.slug).join(", ")}`);

      return { request, concepts };
    },
  })
  .step({
    id: "explain-concepts",
    name: "Explain concepts",
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

      console.log(`[explain-concepts] ${result.output.explanations.length} explanations`);

      return { request, concepts, explanations: result.output.explanations };
    },
  })
  .step({
    id: "generate-quiz",
    name: "Generate quiz",
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

      console.log(`[generate-quiz] ${result.output.questions.length} questions`);

      return { request, concepts, explanations, questions: result.output.questions };
    },
  })
  .step({
    id: "assemble-guide",
    name: "Assemble guide",
    // Deterministic step: it never calls the model. This is where every
    // completeness rule is enforced (docs/adr/0003).
    run: async ({ input }) => {
      const { concepts, explanations, questions } = input as {
        concepts: ExtractedConcept[];
        explanations: { slug: string; explanation: string; whyItMatters: string }[];
        questions: AssembledQuestion[];
      };

      const knownSlugs = new Set(concepts.map((c) => c.slug));

      // An unknown slug means the model produced something nobody asked for; drop it.
      const explanationBySlug = new Map<string, (typeof explanations)[number]>();
      for (const explanation of explanations) {
        if (knownSlugs.has(explanation.slug) && !explanationBySlug.has(explanation.slug)) {
          explanationBySlug.set(explanation.slug, explanation);
        }
      }

      const missingExplanations = concepts
        .filter((c) => !explanationBySlug.has(c.slug))
        .map((c) => c.slug);

      // A concept without an explanation means the model slipped; transient, worth retrying.
      if (missingExplanations.length > 0) {
        throw new MisalignedStepOutputError(
          `Missing explanations for concepts: ${missingExplanations.join(", ")}`,
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
          `Missing questions for concepts: ${conceptsWithoutQuestions.join(", ")}`,
        );
      }

      // Order the questions to follow the learning order of their concepts.
      const assembledQuestions = assembledConcepts.flatMap(
        (concept) => questionsBySlug.get(concept.slug) ?? [],
      );

      console.log(
        `[assemble-guide] ${assembledConcepts.length} concepts, ${assembledQuestions.length} questions`,
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
