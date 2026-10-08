import { Router } from "express";
import { CONVENTIONS } from "../agent/conventions.js";
import { logAudit } from "../db.js";
import { createProposal, getProposal, listProposals, resolveProposal, type Proposal, type ProposalStatus } from "../proposals.js";
import { getSession, listSessions } from "../repo.js";
import { functionCodes, processCodeOf, stepCodes } from "../shared/codes.js";
import { applyPatch, describePatch, issueDelta, type ModelPatch } from "../shared/patch.js";
import { sourceErrors } from "../agent/sources.js";
import { splitAccepted, validateModel } from "../shared/validate.js";
import { ProposalInput, ResolveInput, TakeInput, CompleteInput, TaskInput, AgentTaskInput } from "../types/patch.js";
import { cancelTask, completeTask, createTask, getTask, listTasks, takeTask, type AgentTask, type TaskStatus } from "../agentTasks.js";
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
  // принятые аналитиком замечания (с причиной) агенту не показываем как задачи: они в отдельном списке
  const split = splitAccepted(model.accepted_issues, validateModel(model));
  res.json({
    sessionId: session.id,
    updatedAt: session.updatedAt,
    processCode: processCodeOf(model),
    model,
    // коды функций и шагов — агенту удобнее ссылаться на «B002.01.01», чем на внутренние id
    codes: Object.fromEntries([...functionCodes(model), ...stepCodes(model)]),
    issues: split.active,
    accepted: split.accepted.map((i) => ({ rule: i.rule, element_id: i.element_id, message: i.message, reason: i.reason })),
  });
});

/** Текст интервью по фрагментам: id фрагмента нужен для цитат в источниках новых записей. */
agentRouter.get("/agent/sessions/:id/fragments", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const from = Math.max(0, Number(req.query.from) || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const slice = session.fragments.slice(from, from + limit);
  res.json({ total: session.fragments.length, from, fragments: slice.map((f) => ({ id: f.id, index: f.index, speaker: f.speaker_label ?? f.speaker, text: f.text })) });
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
  const { agent, title, rationale, ops, task_id } = parsed.data;
  if (task_id) {
    const task = getTask(task_id);
    if (!task || task.sessionId !== session.id) {
      res.status(404).json({ error: `задание «${task_id}» не найдено в этой сессии (get_tasks)` });
      return;
    }
    if (task.status === "done" || task.status === "cancelled") {
      res.status(409).json({ error: `задание «${task_id}» уже ${task.status === "done" ? "выполнено" : "отменено"}` });
      return;
    }
  }
  const patch = { ops } as ModelPatch;
  const before = session.model;
  const applied = applyPatch(before, patch);
  if (applied.errors.length > 0) {
    res.status(422).json({ error: "предложение нельзя применить к текущей модели", errors: applied.errors });
    return;
  }
  const sourceProblems = sourceErrors(ops as ModelPatch["ops"], session.fragments);
  if (sourceProblems.length > 0) {
    res.status(422).json({ error: "цитаты в источниках не подтверждаются текстом интервью", errors: sourceProblems });
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
    taskId: task_id ?? null,
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

// --- задания аналитика агенту ---

const TASK_STATUSES: TaskStatus[] = ["open", "taken", "done", "cancelled"];

/** Задание с предложениями, которые по нему отправлены. */
const taskWithProposals = (t: AgentTask) => ({
  ...t,
  proposals: listProposals(t.sessionId)
    .filter((p) => p.taskId === t.id)
    .map((p) => ({ id: p.id, title: p.title, status: p.status })),
});

agentRouter.get("/agent/sessions/:id/tasks", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const status = ((req.query.status as TaskStatus | undefined) ?? "open") as TaskStatus;
  if (!TASK_STATUSES.includes(status)) {
    res.status(400).json({ error: `status: ${TASK_STATUSES.join(" | ")}` });
    return;
  }
  res.json(listTasks(session.id, status).map(taskWithProposals));
});

/** Сколько ожидающих и взятых заданий от агентов допустимо на сессию: защита от лавины заданий. */
const MAX_AGENT_TASKS = 20;

agentRouter.post("/agent/sessions/:id/tasks", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const parsed = AgentTaskInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "text — задание, agent — кому адресовано, from — от кого" });
    return;
  }
  const scope = parsed.data.scope ?? null;
  if (scope && !session.model?.nodes.some((n) => n.id === scope)) {
    res.status(400).json({ error: `функции «${scope}» нет в модели` });
    return;
  }
  const active = listTasks(session.id).filter((t) => t.createdBy.startsWith("agent:") && (t.status === "open" || t.status === "taken")).length;
  if (active >= MAX_AGENT_TASKS) {
    res.status(429).json({ error: `от агентов уже ${active} незавершённых заданий — дождитесь, пока их выполнят или отменит аналитик` });
    return;
  }
  const task = createTask({ sessionId: session.id, text: parsed.data.text, scopeNodeId: scope, agent: parsed.data.agent, createdBy: `agent:${parsed.data.from}` });
  logAudit(session.id, `agent:${parsed.data.from}`, "task_created", { id: task.id, for: parsed.data.agent });
  res.status(201).json(taskWithProposals(task));
});

agentRouter.post("/agent/tasks/:tid/take", (req, res) => {
  const parsed = TakeInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "agent — роль агента" });
    return;
  }
  const task = getTask(req.params.tid);
  if (!task) {
    res.status(404).json({ error: "задание не найдено" });
    return;
  }
  const taken = takeTask(task.id, parsed.data.agent);
  if (!taken) {
    res.status(409).json({ error: `задание уже ${task.status === "taken" ? `взято (${task.takenBy})` : task.status === "done" ? "выполнено" : "отменено"}` });
    return;
  }
  logAudit(task.sessionId, `agent:${parsed.data.agent}`, "task_taken", { id: task.id });
  res.json(taskWithProposals(taken));
});

agentRouter.post("/agent/tasks/:tid/complete", (req, res) => {
  const parsed = CompleteInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "note — итог работы текстом" });
    return;
  }
  const task = getTask(req.params.tid);
  if (!task) {
    res.status(404).json({ error: "задание не найдено" });
    return;
  }
  const done = completeTask(task.id, parsed.data.note);
  if (!done) {
    res.status(409).json({ error: `задание уже ${task.status === "done" ? "выполнено" : "отменено"}` });
    return;
  }
  logAudit(task.sessionId, `agent:${task.takenBy ?? "agent"}`, "task_done", { id: task.id });
  res.json(taskWithProposals(done));
});

// задания: ставит и отменяет аналитик (студия)

agentRouter.get("/sessions/:id/tasks", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  res.json(listTasks(session.id).map(taskWithProposals));
});

agentRouter.post("/sessions/:id/tasks", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "сессия не найдена" });
    return;
  }
  const parsed = TaskInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "text — задание (до 2000 знаков)" });
    return;
  }
  const scope = parsed.data.scope ?? null;
  if (scope && !session.model?.nodes.some((n) => n.id === scope)) {
    res.status(400).json({ error: `функции «${scope}» нет в модели` });
    return;
  }
  const task = createTask({ sessionId: session.id, text: parsed.data.text, scopeNodeId: scope, agent: parsed.data.agent ?? null, createdBy: req.user?.login ?? "analyst" });
  logAudit(session.id, "analyst", "task_created", { id: task.id });
  res.status(201).json(taskWithProposals(task));
});

agentRouter.post("/tasks/:tid/cancel", (req, res) => {
  const task = getTask(req.params.tid);
  if (!task) {
    res.status(404).json({ error: "задание не найдено" });
    return;
  }
  const cancelled = cancelTask(task.id);
  if (!cancelled) {
    res.status(409).json({ error: `задание уже ${task.status === "done" ? "выполнено" : "отменено"}` });
    return;
  }
  logAudit(task.sessionId, "analyst", "task_cancelled", { id: task.id });
  res.json(taskWithProposals(cancelled));
});