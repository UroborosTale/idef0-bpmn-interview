import "./env.js";
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
import { visioRouter } from "./routes/visio.js";
import "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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
app.use("/api", visioRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message ?? "internal error" });
});

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`API сервер запущен: http://localhost:${PORT}`);
});
