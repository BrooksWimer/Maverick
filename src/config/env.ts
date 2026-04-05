import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

let loaded = false;

export function loadEnvironment() {
  if (loaded) {
    return;
  }

  const cwd = process.cwd();
  const envPath = resolve(cwd, ".env");
  const fallbackPath = resolve(cwd, ".env.example");

  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    loaded = true;
    return;
  }

  if (existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath });
    loaded = true;
  }
}
