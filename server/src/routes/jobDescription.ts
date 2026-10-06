import { Router } from "express";
import { getSession } from "../repo.js";
import { db } from "../db.js";
import { buildJobDescriptionHtml, buildJobDescriptionDocx } from "../export/jobDescription.js";
import type { RolePositionInfo } from "../pipeline/jobDescription.js";

export const jobDescriptionRouter = Router();

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
  if (!session.model.roles.some((r) => r.id === req.params.roleId)) {
    res.status(404).json({ error: "роль не найдена в модели" });
    return null;
  }
  return session;
}

function lookupPosition(roleName: string): RolePositionInfo | undefined {
  const row = db
    .prepare(
      `SELECT p.title AS title, p.department AS department
       FROM role_position_map m JOIN positions p ON p.key = m.position_key
       WHERE m.role_key = ? LIMIT 1`
    )
    .get(roleName.toLowerCase()) as { title: string; department: string | null } | undefined;
  return row ? { title: row.title, department: row.department } : undefined;
}

/** ФТ-М1.2: HTML-предпросмотр должностной инструкции роли. */
jobDescriptionRouter.get("/sessions/:id/job-description/:roleId/preview", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const role = session.model!.roles.find((r) => r.id === req.params.roleId)!;
  res.type("text/html; charset=utf-8").send(buildJobDescriptionHtml(session, req.params.roleId, lookupPosition(role.name)));
});

jobDescriptionRouter.get("/sessions/:id/job-description/:roleId/export.html", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const role = session.model!.roles.find((r) => r.id === req.params.roleId)!;
  res.setHeader("Content-Disposition", `attachment; filename="job-description.html"`);
  res.type("text/html; charset=utf-8").send(buildJobDescriptionHtml(session, req.params.roleId, lookupPosition(role.name)));
});

jobDescriptionRouter.get("/sessions/:id/job-description/:roleId/export.docx", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const role = session.model!.roles.find((r) => r.id === req.params.roleId)!;
  const buf = await buildJobDescriptionDocx(session, req.params.roleId, lookupPosition(role.name));
  res.setHeader("Content-Disposition", `attachment; filename="job-description.docx"`);
  res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(buf);
});
