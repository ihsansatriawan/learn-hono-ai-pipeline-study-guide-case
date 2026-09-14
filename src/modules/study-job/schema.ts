import z from "zod";
import { LANGUAGES, LEVELS, SOURCE_TEXT_MAX, SOURCE_TEXT_MIN } from "../../pipeline/schema";

export const CreateStudyJobSchema = z.object({
  sourceText: z
    .string()
    .trim()
    .min(SOURCE_TEXT_MIN, `The material must be at least ${SOURCE_TEXT_MIN} characters.`)
    .max(SOURCE_TEXT_MAX, `The material must be at most ${SOURCE_TEXT_MAX} characters.`),
  level: z.enum(LEVELS).default("beginner"),
  language: z.enum(LANGUAGES).default("id"),
});

export const ListStudyJobsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export type CreateStudyJobInput = z.infer<typeof CreateStudyJobSchema>;
export type ListStudyJobsQuery = z.infer<typeof ListStudyJobsSchema>;
