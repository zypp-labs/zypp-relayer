import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  RPC_URLS: z
    .string()
    .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "At least one RPC URL required"),
  RPC_CONFIRMATION_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("confirmed"),
  RPC_CONFIRMATION_TIMEOUT_MS: z.coerce.number().default(60_000),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),

  BULL_CONCURRENCY: z.coerce.number().default(5),
  BULL_MAX_ATTEMPTS: z.coerce.number().default(5),
  BULL_BACKOFF_MS: z.coerce.number().default(1000),

  RELAYER_SECRET_KEY: z.string().min(1),
  USDC_MINT_ADDRESS: z.string().min(1),
  HOT_WALLET_ADDRESS: z.string().min(1),
  RELAYER_INTENT_DOMAIN: z.string().min(1),
  RELAYER_API_KEY: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid config:", parsed.error.flatten());
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}
