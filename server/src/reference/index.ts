import type { ProcessLogicModel } from "../types/model.js";
import { b002Model } from "./b002.js";
import { c025Model } from "./c025.js";
import { demoModel } from "./demo.js";

/** Эталонные и демонстрационные процессы, которые можно загрузить в приложение (npm run seed:process). */
export const REFERENCE_PROCESSES: Record<string, { title: string; build: () => ProcessLogicModel }> = {
  b002: { title: "эталон B002", build: b002Model },
  c025: { title: "процесс C025 из документа «ДПО от 05.10»", build: c025Model },
  demo: { title: "демонстрационный процесс C090 со всеми возможностями редактора", build: demoModel },
};