import { Router } from "express";
import { getSession } from "../repo.js";
import { buildCamundaBpmn, buildElma365Export, buildCompletenessReport } from "../pipeline/bpmsExport.js";

export const bpmsRouter = Router();

function requireReady(req: any, res: any) {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return null;
  }
  if (!session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return null;
  }
  return session;
}

/** ФТ-М1.4.1/1.4.2: экспорт исполняемого BPMN с расширениями Camunda. */
bpmsRouter.get("/sessions/:id/bpms/camunda.bpmn", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const { xml } = buildCamundaBpmn(session.model!);
  res.setHeader("Content-Disposition", `attachment; filename="camunda.bpmn"`);
  res.type("application/xml").send(xml);
});

/** ФТ-М1.4.1: экспорт общего JSON для ELMA365 (см. примечание в pipeline/bpmsExport.ts о неполноте публичной документации формата). */
bpmsRouter.get("/sessions/:id/bpms/elma365.json", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const { data } = buildElma365Export(session.model!);
  res.setHeader("Content-Disposition", `attachment; filename="elma365.json"`);
  res.type("application/json").send(JSON.stringify(data, null, 2));
});

/** ФТ-М1.4.3: отчёт о неполноте выгрузки — что требует ручной доработки перед запуском в BPMS. */
bpmsRouter.get("/sessions/:id/bpms/completeness-report", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const target = (req.query.target as string) === "elma365" ? "elma365" : "camunda";
  const notes = target === "camunda" ? buildCamundaBpmn(session.model!).completenessNotes : buildElma365Export(session.model!).completenessNotes;
  res.json(buildCompletenessReport(session.model!, target, notes));
});
