import "dotenv/config";
import z from "zod";

// Fail fast at boot: a misconfigured process must not accept requests or pull
// jobs off the queue.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_HOST: z.string().min(1).default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6382),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().optional(),
  MODEL_ID: z.string().min(1).default("openai/gpt-5.6-luna"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${detail}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
