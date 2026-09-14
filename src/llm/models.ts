import { OpenAIClient } from "@anvia/openai";
import { env } from "../config/env";

const client = new OpenAIClient({
  apiKey: env.OPENAI_API_KEY,
  baseUrl: env.OPENAI_BASE_URL || undefined,
});

export const model = client.completionModel({
  modelId: env.MODEL_ID,
  api: "chat",
});
