import { loadEnvironment } from "../config/env.js";
import { closeDatabase, initDatabase } from "./index.js";

loadEnvironment();

initDatabase(process.env.DATABASE_PATH);
closeDatabase();
console.log("Database schema applied.");
