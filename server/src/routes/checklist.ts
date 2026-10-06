import { Router } from "express";
import { getSession } from "../repo.js";
import { db } from "../db.js";
import { runChecklist } from "../pipeline/checklist.js";

export const checklistRouter = Router();

interface ChecklistRuleRow {
  id: string;
  code: string;
  label: string;
  enabled: number;
}

/** ФТ-М6.2.2: список правил чек-листа (настраивается — какие включены). */
checklistRouter.get("/checklist-rules", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM checklist_rules ORDER BY label`).all());
});

checklistRouter.patch("/checklist-rules/:id", (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  db.prepare(`UPDATE checklist_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, req.params.id);
  const row = db.prepare(`SELECT * FROM checklist_rules WHERE id = ?`).get(req.params.id);
  res.json(row);
});

/** ФТ-М6.2.3: результат проверки — процент соответствия и список несоответствий. */
checklistRouter.get("/sessions/:id/checklist", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(400).json({ error: "модель ещё не построена" });
    return;
  }
  const rules = (db.prepare(`SELECT * FROM checklist_rules WHERE enabled = 1 ORDER BY label`).all() as ChecklistRuleRow[]).map((r) => ({ code: r.code, label: r.label }));
  res.json(runChecklist(session.model, rules));
});
