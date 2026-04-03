import pino from "pino";

export function createLogger(level: string = "info") {
  return pino({
    level,
    ...(process.env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type Logger = pino.Logger;
