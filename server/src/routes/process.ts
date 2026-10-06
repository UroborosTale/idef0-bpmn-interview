import { Router } from "express";
import { getSession, updateSession, editBlockReason } from "../repo.js";
import { fragmentText, normalizeTerms, anonymizeFragments } from "../pipeline/fragment.js";
import { parseUploadedFile } from "../pipeline/ingest.js";
import { runOrchestratedPipeline } from "../pipeline/agents.js";
import { logAudit } from "../db.js";
import { db } from "../db.js";
import { addVersion } from "../repo.js";
import type { Fragment } from "../types/model.js";

export const processRouter = Router();

function loadGlossary(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM glossary WHERE kind = 'term'`).all() as { key: string; value: string }[];
  const dict: Record<string, string> = {};
  for (const r of rows) dict[r.key] = r.value;
  return dict;
}

async function ingest(sessionId: string, rawText: string, opts: { append?: boolean; anonymize?: boolean; sourceLabel?: string }) {
  const session = getSession(sessionId);
  if (!session) throw new Error("not found");

  let fragments = fragmentText(rawText);
  fragments = normalizeTerms(fragments, loadGlossary());
  if (opts.anonymize) fragments = anonymizeFragments(fragments);

  let combinedFragments: Fragment[];
  let combinedText: string;
  if (opts.append && session.fragments.length > 0) {
    const offset = session.fragments.length;
    fragments = fragments.map((f, i) => ({ ...f, id: `f${offset + i + 1}`, index: offset + i + 1 }));
    combinedFragments = [...session.fragments, ...fragments];
    combinedText = `${session.rawText}\n\n--- ${opts.sourceLabel ?? "доп. интервью"} ---\n\n${rawText}`;
  } else {
    combinedFragments = fragments;
    combinedText = rawText;
  }

  return updateSession(sessionId, { fragments: combinedFragments, rawText: combinedText, status: "draft" });
}

processRouter.post("/sessions/:id/ingest-text", async (req, res) => {
  const { text, append, anonymize, sourceLabel } = req.body as {
    text: string;
    append?: boolean;
    anonymize?: boolean;
    sourceLabel?: string;
  };
  if (!text || !text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const updated = await ingest(req.params.id, text, { append, anonymize, sourceLabel });
    logAudit(req.params.id, "analyst", "text_ingested", { length: text.length, append: !!append });
    res.json(updated);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

processRouter.post("/sessions/:id/upload", async (req, res) => {
  const { filename, contentBase64, append, anonymize } = req.body as {
    filename: string;
    contentBase64: string;
    append?: boolean;
    anonymize?: boolean;
  };
  if (!filename || !contentBase64) {
    res.status(400).json({ error: "filename and contentBase64 are required" });
    return;
  }
  try {
    const text = await parseUploadedFile(filename, contentBase64);
    if (!text.trim()) {
      res.status(422).json({ error: "не удалось извлечь текст из файла" });
      return;
    }
    const updated = await ingest(req.params.id, text, { append, anonymize, sourceLabel: filename });
    logAudit(req.params.id, "analyst", "file_uploaded", { filename });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: `Ошибка разбора файла: ${(e as Error).message}` });
  }
});

processRouter.post("/sessions/:id/run", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (session.fragments.length === 0) {
    res.status(400).json({ error: "нет текста интервью для обработки" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  updateSession(req.params.id, { status: "processing" });
  try {
    const output = await runOrchestratedPipeline(session.id, session.fragments, session.meta);
    updateSession(req.params.id, {
      model: output.model,
      validation: output.validation,
      bpmnXml: output.bpmnXml,
      idef0: output.idef0,
      status: "ready",
      diagramsStale: false,
      provider: output.providerName,
    });
    logAudit(req.params.id, "analyst", "pipeline_run", { provider: output.providerName, nodes: output.model.nodes.length, agentRunId: output.runId, iterations: output.iterations });
    const updated = addVersion(req.params.id, "Запуск конвейера извлечения");
    res.json(updated);
  } catch (e) {
    updateSession(req.params.id, { status: "draft" });
    res.status(500).json({ error: (e as Error).message });
  }
});

processRouter.get("/sessions/:id/questions", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "модель ещё не построена" });
    return;
  }
  const open = session.model.gaps.filter((g) => g.status === "open");
  const priorityLabel: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };
  const lines = [
    `Лист уточняющих вопросов`,
    `Процесс: ${session.meta.processName}`,
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...open
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "critical" ? -1 : 1))
      .map((g, i) => `${i + 1}. [${priorityLabel[g.priority]}] ${g.question}`),
  ];
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

processRouter.post("/sessions/:id/answers", async (req, res) => {
  const { gapId, answerText } = req.body as { gapId: string; answerText: string };
  const session = getSession(req.params.id);
  if (!session || !session.model) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const gap = session.model.gaps.find((g) => g.id === gapId);
  if (!gap) {
    res.status(404).json({ error: "gap not found" });
    return;
  }
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const offset = session.fragments.length;
  const newFragment: Fragment = { id: `f${offset + 1}`, index: offset + 1, speaker: "owner", speaker_label: "Ответ на уточнение", text: answerText };
  const fragments = [...session.fragments, newFragment];
  const qa = [...session.qa, { gapId, question: gap.question, answerText, ts: new Date().toISOString() }];
  updateSession(req.params.id, { fragments, qa, status: "processing" });

  try {
    const output = await runOrchestratedPipeline(session.id, fragments, session.meta);
    updateSession(req.params.id, {
      model: output.model,
      validation: output.validation,
      bpmnXml: output.bpmnXml,
      idef0: output.idef0,
      status: "ready",
      diagramsStale: false,
    });
    logAudit(req.params.id, "owner", "gap_answered", { gapId });
    const updated = addVersion(req.params.id, `Ответ на уточнение: ${gap.question.slice(0, 60)}`);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
