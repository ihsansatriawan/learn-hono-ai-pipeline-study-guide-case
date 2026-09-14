import "dotenv/config";
import z from "zod";

// Gagal-cepat saat boot: proses yang salah konfigurasi tidak boleh menerima
// permintaan atau mengambil job dari antrean.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1, "DATABASE_URL wajib diisi"),
  REDIS_HOST: z.string().min(1).default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6382),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY wajib diisi"),
  OPENAI_BASE_URL: z.string().optional(),
  MODEL_ID: z.string().min(1).default("openai/gpt-5.6-luna"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Konfigurasi environment tidak valid:\n${detail}\n\nSalin .env.example ke .env lalu lengkapi.`);
}

export const env = parsed.data;
