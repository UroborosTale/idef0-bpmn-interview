import { Router } from "express";
import { getSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import { buildRaci, buildRaciWorkbookBuffer } from "../pipeline/raci.js";
import { validateModel } from "../pipeline/validate.js";
import { logAudit } from "../db.js";

export const raciRouter = Router();

/** ФТ-М1.3.1: автопостроение матрицы RACI из текущей модели (заменяет текущую матрицу). */
raciRouter.post("/sessions/:id/raci/build", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const raci = buildRaci(session.model);
  const model = { ...session.model, raci };
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, diagramsStale: session.diagramsStale });
  logAudit(req.params.id, "analyst", "raci_built", { entries: raci.length });
  const updated = addVersion(req.params.id, "Автопостроение матрицы RACI");
  res.json(updated);
});

/** ФТ-М1.3.3: ручное добавление записи RACI. */
raciRouter.post("/sessions/:id/raci/entries", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { node_id, role_id, type } = req.body as { node_id: string; role_id: string; type: "R" | "A" | "C" | "I" };
  if (!node_id || !role_id || !type) {
    res.status(400).json({ error: "node_id, role_id, type are required" });
    return;
  }
  const exists = session.model.raci.some((r) => r.node_id === node_id && r.role_id === role_id && r.type === type);
  const raci = exists ? session.model.raci : [...session.model.raci, { node_id, role_id, type }];
  const model = { ...session.model, raci };
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation });
  const updated = addVersion(req.params.id, "Правка матрицы RACI");
  res.json(updated);
});

/** ФТ-М1.3.3: удаление записи RACI. */
raciRouter.delete("/sessions/:id/raci/entries", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { node_id, role_id, type } = req.body as { node_id: string; role_id: string; type: "R" | "A" | "C" | "I" };
  const raci = session.model.raci.filter((r) => !(r.node_id === node_id && r.role_id === role_id && r.type === type));
  const model = { ...session.model, raci };
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation });
  const updated = addVersion(req.params.id, "Правка матрицы RACI");
  res.json(updated);
});

/** ФТ-М1.3.3: выгрузка матрицы RACI в .xlsx (строки — действия, столбцы — роли). */
raciRouter.get("/sessions/:id/raci/export/xlsx", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const buf = buildRaciWorkbookBuffer(session.model);
  res.setHeader("Content-Disposition", `attachment; filename="raci.xlsx"`);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buf);
});
