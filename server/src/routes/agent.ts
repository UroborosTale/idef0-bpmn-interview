import { Router } from "express";
import { CONVENTIONS } from "../agent/conventions.js";
import { logAudit } from "../db.js";
import { createProposal, getProposal, listProposals, resolveProposal, type Proposal, type ProposalStatus } from "../proposals.js";
import { getSession, listSessions } from "../repo.js";
import { functionCodes, processCodeOf, stepCodes } from "../shared/codes.js";
import { applyPatch, describePatch, issueDelta, type ModelPatch } from "../shared/patch.js";
import { validateModel } from "../shared/validate.js";
import { ProposalInput, ResolveInput } from "../types/patch.js";
import { ProcessLogicModel } from "../types/model.js";

/**
 * Работа агентов с моделью. Агент (Cline и его субагенты через MCP-сервер, server/src/mcp) читает модель и проверки и
 * отправляет предложения правок; человек применяет или отклоняет их в студии. Агентские ручки (/agent/*) доступны и по
 * токену AGENT_API_TOKEN (см. auth.ts), ручки решения — только вошедшему аналитику.
 */
export const agentRouter = Router();

const STATUSES: ProposalStatus[] = ["pending", "applied", "rejected"];

/** Предложение глазами агента: статус, причина отказа и описание правок по-русски. */
function present(p: Proposal, modelOf: (id: string) => ProcessLogicModel | undefined) {
  const model = modelOf(p.sessionId);
  return { ...p, lines: model ? describePatch(model, p.patch) : [] };
}

agentRouter.get("/agent/conventions", (_req, res) => {
  res.type("text/markdown; charset=utf-8").send(CONVENTIONS);
});

agentRouter.get("/agent/sessions", (_req, res) => {
  res.json(
    listSessions().map((s) => ({
      id: s.id,
      title: s.title,
      processName: s.meta.processName,
      code: s.model?.process.code ?? null,
      hasModel: !!s.model,
      updatedAt: s.updatedAt,
    }))
  );
});

agentRouter.get("/agent/sessions/:id/model", (req, res) => {
  const session = getSession(req.params.id);
  if (!session?.model) {
    res.status(404).json({ error: "у сессии нет модели" });
    return;
  }
  const model = session.model;
  res.json({
    sessionId: session.id,
    updatedAt: session.updatedAt,
    processCode: processCodeOf(model),
    model,
    // коды функций и шагов — агенту удобнее ссылаться на «B002.01.01», чем на внутренние id
    codes: Object.fromEntries([...functionCodes(model), ...stepCodes(model)]),
    issues: validateModel(model),
  });
});

agentRouter.post("/agent/sessions/:id/proposals", (req, res) => {
  const session = getSession(req.params.id);
  if (!session?.model) {
    res.status(404).json({ error: "у сессии нет модели" });
    return;
  }
  const parsed = ProposalInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "предложение не соответствует формату", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    return;
  }
  const { agent, title, rationale, ops } = parsed.data;
  const patch = { ops } as ModelPatch;
  const before = session.model;
  const applied = applyPatch(before, patch);
  if (applied.errors.length > 0) {
    res.status(422).json({ error: "предложение нельзя применить к текущей модели", errors: applied.errors });
    return;
  }
  const full = ProcessLogicModel.safeParse(applied.model);
  if (!full.success) {
    res.status(422).json({ error: "после применения модель нарушила схему", errors: full.error.issues.map((i) => ({ index: null, message: `${i.path.join(".")}: ${i.message}` })) });
    return;
  }
  const delta = issueDelta(validateModel(before), validateModel(full.data));
  const brief = (xs: typeof delta.introduced) => xs.map((i) => ({ severity: i.severity, message: i.message }));
  const proposal = createProposal({
    sessionId: session.id,
    agent,
    title,
    rationale,
    patch,
    delta: { introduced: brief(delta.introduced), resolved: brief(delta.resolved) },
    baseUpdatedAt: session.updatedAt,
  });
  logAudit(session.id, `agent:${agent}`, "proposal_created", { id: proposal.id, title, ops: ops.length });
  res.status(201).json({
    id: proposal.id,
    status: proposal.status,
    lines: describePatch(before, patch),
    delta: proposal.delta,
  });
});

agentRouter.get("/agent/sessions/:id/proposals", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const status = req.query.status as ProposalStatus | undefined;
  if (status && !STATUSES.includes(status)) {
    res.status(400).json({ error: `status: ${STATUSES.join(" | ")}` });
    return;
  }
  const modelOf = () => session.model ?? undefined;
  res.json(listProposals(session.id, status).map((p) => ({ ...present(p, modelOf), stale: p.baseUpdatedAt !== session.updatedAt })));
});

agentRouter.get("/agent/proposals/:pid", (req, res) => {
  const p = getProposal(req.params.pid);
  if (!p) {
    res.status(404).json({ error: "предложение не найдено" });
    return;
  }
  const session = getSession(p.sessionId);
  res.json({ ...present(p, () => session?.model ?? undefined), stale: !!session && p.baseUpdatedAt !== session.updatedAt });
});

// --- решение человека (студия) ---

agentRouter.get("/sessions/:id/proposals", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const status = (req.query.status as ProposalStatus | undefined) ?? undefined;
  res.json(listProposals(session.id, status && STATUSES.includes(status) ? status : undefined).map((p) => ({ ...p, stale: p.baseUpdatedAt !== session.updatedAt })));
});

agentRouter.post("/proposals/:pid/resolve", (req, res) => {
  const parsed = ResolveInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "status: applied | rejected" });
    return;
  }
  const existing = getProposal(req.params.pid);
  if (!existing) {
    res.status(404).json({ error: "предложение не найдено" });
    return;
  }
  const by = req.user?.login ?? "analyst";
  const resolved = resolveProposal(existing.id, parsed.data.status, by, parsed.data.reason);
  if (!resolved) {
    res.status(409).json({ error: `предложение уже ${existing.status === "applied" ? "применено" : "отклонено"}` });
    return;
  }
  logAudit(existing.sessionId, "analyst", `proposal_${parsed.data.status}`, { id: existing.id, title: existing.title, reason: parsed.data.reason });
  res.json(resolved);
});
