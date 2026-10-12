/** Приложение Express без запуска сервера: его импортируют index.ts и тесты. */
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sessionsRouter } from "./routes/sessions.js";
import { processRouter } from "./routes/process.js";
import { interviewRouter } from "./routes/interview.js";
import { exportRouter } from "./routes/export.js";
import { glossaryRouter } from "./routes/glossary.js";
import { templatesRouter } from "./routes/templates.js";
import { registryRouter } from "./routes/registry.js";
import { versionsRouter } from "./routes/versions.js";
import { raciRouter } from "./routes/raci.js";
import { regulationRouter } from "./routes/regulation.js";
import { cardRouter } from "./routes/card.js";
import { multiInterviewRouter } from "./routes/multiInterview.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { verificationRouter } from "./routes/verification.js";
import { reviewRouter } from "./routes/review.js";
import { impactAnalysisRouter } from "./routes/impactAnalysis.js";
import { notificationsRouter } from "./routes/notifications.js";
import { analyticsRouter } from "./routes/analytics.js";
import { requirementsRouter } from "./routes/requirements.js";
import { checklistRouter } from "./routes/checklist.js";
import { traceabilityRouter } from "./routes/traceability.js";
import { auditRouter } from "./routes/audit.js";
import { jobDescriptionRouter } from "./routes/jobDescription.js";
import { technologyRouter } from "./routes/technology.js";
import { hypothesesRouter } from "./routes/hypotheses.js";
import { miningRouter } from "./routes/mining.js";
import { adaptiveDepthRouter } from "./routes/adaptiveDepth.js";
import { bpmsRouter } from "./routes/bpms.js";
import { diagramImportRouter } from "./routes/diagramImport.js";
import { auditPackageRouter } from "./routes/auditPackage.js";
import { agentRouter } from "./routes/agent.js";
import { repositoryRouter } from "./routes/repository.js";
import { db } from "./db.js";
import { failInterruptedJobs } from "./jobs.js";
import { authRouter, rateLimit, requireAuth, securityHeaders } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Обработка, оборванная перезапуском сервера: задачи — в ошибку, сессии — из «processing» в прежнее состояние.
failInterruptedJobs();
db.prepare(`UPDATE sessions SET status = CASE WHEN model_json IS NULL THEN 'draft' ELSE 'ready' END WHERE status = 'processing'`).run();

export const app = express();
// за обратным прокси (nginx в docker-compose) адрес клиента и протокол берутся из X-Forwarded-*
app.set("trust proxy", "loopback, uniquelocal");
// Клиент обращается к API с того же адреса (прокси Vite или nginx). Чужие источники — только явно перечисленные.
const corsOrigins = (process.env.CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length) app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "25mb" }));
app.use("/api", securityHeaders);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", authRouter);
app.use("/api", requireAuth);
// ответы респондентов по персональной ссылке открыты без входа — ограничиваем частоту по токену
app.use(
  "/api/campaigns/:campaignId/respond/:token",
  rateLimit(60, 60_000, (req) => req.params.token ?? "?")
);

// Схема PLM публикуется как версионированный контракт (ТЗ на развитие, 2.2):
// /v1 — исходная схема Ядра, /v2 — текущая (расширенная модулями развития),
// /latest — алиас на актуальную версию. Старый путь без версии сохранён
// для обратной совместимости и указывает на v1 (поведение не менялось).
const schemaFile = (name: string) => path.join(__dirname, "schema", name);
app.get("/api/schema/process-logic.json", (_req, res) => {
  res.type("application/json").send(fs.readFileSync(schemaFile("process-logic.schema.json"), "utf-8"));
});
app.get("/api/schema/process-logic/v1", (_req, res) => {
  res.type("application/json").send(fs.readFileSync(schemaFile("process-logic.schema.json"), "utf-8"));
});
app.get("/api/schema/process-logic/v2", (_req, res) => {
  res.type("application/json").send(fs.readFileSync(schemaFile("process-logic.v2.schema.json"), "utf-8"));
});
app.get("/api/schema/process-logic/latest", (_req, res) => {
  res.type("application/json").send(fs.readFileSync(schemaFile("process-logic.v2.schema.json"), "utf-8"));
});

app.use("/api", sessionsRouter);
app.use("/api", processRouter);
app.use("/api", interviewRouter);
app.use("/api", exportRouter);
app.use("/api", glossaryRouter);
app.use("/api", templatesRouter);
app.use("/api", registryRouter);
app.use("/api", versionsRouter);
app.use("/api", raciRouter);
app.use("/api", regulationRouter);
app.use("/api", cardRouter);
app.use("/api", multiInterviewRouter);
app.use("/api", campaignsRouter);
app.use("/api", verificationRouter);
app.use("/api", reviewRouter);
app.use("/api", impactAnalysisRouter);
app.use("/api", notificationsRouter);
app.use("/api", analyticsRouter);
app.use("/api", requirementsRouter);
app.use("/api", checklistRouter);
app.use("/api", traceabilityRouter);
app.use("/api", auditRouter);
app.use("/api", jobDescriptionRouter);
app.use("/api", technologyRouter);
app.use("/api", hypothesesRouter);
app.use("/api", miningRouter);
app.use("/api", adaptiveDepthRouter);
app.use("/api", bpmsRouter);
app.use("/api", diagramImportRouter);
app.use("/api", auditPackageRouter);
app.use("/api", agentRouter);
app.use("/api", repositoryRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // ошибки разбора запроса (body-parser) несут свой код: слишком большое тело — 413, повреждённый JSON — 400; это не сбой сервера
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 413) {
    res.status(413).json({ error: "Запрос слишком большой: предел — 25 МБ (файл при передаче занимает на треть больше своего размера). Уменьшите файл или разбейте схему на несколько." });
    return;
  }
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: err.type === "entity.parse.failed" ? "Запрос не разобран: тело не является корректным JSON" : err.message ?? "bad request" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err?.message ?? "internal error" });
});
