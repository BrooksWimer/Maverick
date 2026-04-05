/**
 * Centralized logger using pino.
 * Every module gets a child logger with a component name.
 */
import pino from "pino";

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "production"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

export function createLogger(component: string) {
  return rootLogger.child({ component });
}

export default rootLogger;
