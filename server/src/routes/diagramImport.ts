import { Router } from "express";
import { getSession, createSession, updateSession, addVersion, editBlockReason } from "../repo.js";
import { logAudit } from "../db.js";
import {
  parseBpmnXml,
  buildModelFromParsedBpmn,
  reconcileBpmnEdit,
  parseDrawioXml,
  reconcileDrawioIdef0Edit,
  buildModelFromParsedDrawio,
} from "../pipeline/diagramImport.js";
import { parseVsdx, buildModelFromParsedVsdx, reconcileVsdxEdit, applySheetEdits, applyIdef0Edits, applyDeletions } from "../pipeline/vsdxImport.js";
import { parseXlsx, buildModelFromTable } from "../pipeline/xlsxImport.js";
import { stepsTemplateXlsx } from "../pipeline/xlsxTemplate.js";
import { detectGaps } from "../pipeline/gaps.js";
import { validateModel } from "../pipeline/validate.js";
import { generateBpmn } from "../pipeline/bpmn.js";
import { generateIdef0 } from "../pipeline/idef0.js";
import { resolveProvider } from "../llm/provider.js";
import type { SessionMeta } from "../repo.js";

export const diagramImportRouter = Router();

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

/** ФТ-М9.4.1: правки из bpmn.io/Camunda Modeler — отправка обратно в PLM текущей сессии. */
diagramImportRouter.post("/sessions/:id/diagram-import/bpmn", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { xml } = req.body as { xml: string };
  if (typeof xml !== "string" || !xml.trim()) {
    res.status(400).json({ error: "xml обязателен" });
    return;
  }
  const parsed = parseBpmnXml(xml);
  const { model, changes } = reconcileBpmnEdit(session.model!, parsed);
  model.gaps = detectGaps(model);
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, diagramsStale: true });
  logAudit(req.params.id, "analyst", "diagram_bpmn_reimported", { renamed: changes.renamed.length, added: changes.added.length, missing: changes.missing.length });
  const updated = addVersion(req.params.id, "Правки из внешнего BPMN-редактора");
  res.json({ session: updated, changes, warnings: parsed.warnings });
});

/** Правки из Visio (встроенный редактор настольного приложения или внешний Visio): .vsdx нашей выгрузки, файл в base64. */
diagramImportRouter.post("/sessions/:id/diagram-import/vsdx", async (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { content, deleteMissing } = req.body as { content: string; deleteMissing?: boolean };
  if (typeof content !== "string" || !content) {
    res.status(400).json({ error: "content (файл .vsdx в base64) обязателен" });
    return;
  }
  let parsed: Awaited<ReturnType<typeof parseVsdx>>;
  try {
    parsed = await parseVsdx(Buffer.from(content, "base64"));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const { model, changes } = reconcileVsdxEdit(session.model!, parsed);
  const sheetsChanged = applySheetEdits(model, parsed.sheets); // размер листа, заданный в Visio
  const idef0 = applyIdef0Edits(model, parsed.idef0); // названия блоков и стрелок IDEF0
  // удалённое в Visio удаляется из модели только по подтверждению пользователя (deleteMissing); иначе оно лишь перечисляется
  let deleted = { nodes: 0, flows: 0, arrows: 0 };
  if (deleteMissing) deleted = applyDeletions(model, [...changes.missing, ...idef0.missingFunctions], changes.missingFlows, idef0.missingArrows);
  Object.assign(changes as object, { sheets: sheetsChanged, idef0, deleted });
  model.gaps = detectGaps(model);
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, diagramsStale: true });
  logAudit(req.params.id, "analyst", "diagram_vsdx_reimported", { renamed: changes.renamed.length, added: changes.added.length, addedFlows: changes.addedFlows.length, missing: changes.missing.length });
  const updated = addVersion(req.params.id, "Правки из Visio");
  res.json({ session: updated, changes, warnings: parsed.warnings });
});

/** ФТ-М9.4.2: правки названий узлов IDEF0, внесённые в draw.io — отправка обратно в PLM. */
diagramImportRouter.post("/sessions/:id/diagram-import/drawio-idef0", (req, res) => {
  const session = requireReady(req, res);
  if (!session) return;
  const block = editBlockReason(session);
  if (block) {
    res.status(409).json({ error: block });
    return;
  }
  const { xml } = req.body as { xml: string };
  if (typeof xml !== "string" || !xml.trim()) {
    res.status(400).json({ error: "xml обязателен" });
    return;
  }
  const parsed = parseDrawioXml(xml);
  const { model, changes } = reconcileDrawioIdef0Edit(session.model!, parsed);
  const validation = validateModel(model);
  updateSession(req.params.id, { model, validation, diagramsStale: true });
  logAudit(req.params.id, "analyst", "diagram_drawio_reimported", { renamed: changes.length });
  const updated = addVersion(req.params.id, "Правки названий из draw.io (IDEF0)");
  res.json({ session: updated, changes, warnings: parsed.warnings });
});

/** Образец таблицы шагов для импорта из Excel (формат — в pipeline/xlsxImport.ts). */
diagramImportRouter.get("/diagram-import/template.xlsx", (_req, res) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="process-steps-template.xlsx"`);
  res.send(stepsTemplateXlsx());
});

/** ФТ-М9.5.1/9.5.2: распознавание диаграммы на входе — .bpmn/.drawio (текст) и .vsdx (base64) разбираются напрямую, изображение — через LLM. */
diagramImportRouter.post("/diagram-import/new", async (req, res) => {
  const { format, content, meta } = req.body as { format: string; content: string; meta: SessionMeta };
  if (!format || !content) {
    res.status(400).json({ error: "format и content обязательны" });
    return;
  }
  if (!meta?.processName) {
    res.status(400).json({ error: "meta.processName обязателен" });
    return;
  }

  let built: { model: ReturnType<typeof buildModelFromParsedBpmn>["model"]; warnings: string[] };
  try {
    if (format === "vsdx") {
      // двоичный файл приходит в base64
      const parsed = await parseVsdx(Buffer.from(content, "base64"));
      built = buildModelFromParsedVsdx(parsed, meta);
      if (built.model.nodes.length === 0) {
        res.status(400).json({ error: `В файле не найдено ни одной фигуры процесса. ${parsed.warnings.join(" ")}`.trim() });
        return;
      }
    } else if (format === "xlsx") {
      built = buildModelFromTable(await parseXlsx(Buffer.from(content, "base64")), meta);
    } else if (format === "bpmn") {
      const parsed = parseBpmnXml(content);
      built = buildModelFromParsedBpmn(parsed, meta);
    } else if (format === "drawio") {
      const parsed = parseDrawioXml(content);
      built = buildModelFromParsedDrawio(parsed, meta);
    } else if (format === "image") {
      const { mimeType } = req.body as { mimeType?: string };
      const provider = resolveProvider(meta.confidential);
      if (!provider.recognizeDiagramImage) {
        res.status(400).json({ error: `Провайдер "${provider.name}" не поддерживает распознавание изображений — требуется провайдер с мультимодальной моделью (настройте ANTHROPIC_API_KEY).` });
        return;
      }
      const chunk = await provider.recognizeDiagramImage(content, mimeType || "image/png", { processName: meta.processName, modelType: meta.modelType ?? "AS-IS" });
      // Переиспользуем тот же путь сборки модели, что и обычное текстовое извлечение,
      // но без фрагментов текста — единственный "фрагмент" синтетический (diagram_image).
      const { extractModel } = await import("../pipeline/extract.js");
      const syntheticFragment = { id: "diagram_image", index: 1, speaker: "owner" as const, text: "(распознано с изображения)" };
      const oneShotProvider = { name: provider.name, extractChunk: async () => chunk };
      const model = await extractModel([syntheticFragment], oneShotProvider, {
        processId: `proc_${Date.now()}`,
        processName: meta.processName,
        modelType: meta.modelType ?? "AS-IS",
        department: meta.department,
        owner: meta.owner,
        decompositionDepth: meta.decompositionDepth,
      });
      built = { model, warnings: [] };
    } else {
      res.status(400).json({ error: `Неизвестный формат: ${format}` });
      return;
    }
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }

  // ФТ-М9.5.3: распознанная модель проходит валидацию Ядра.
  built.model.gaps = detectGaps(built.model);
  const validation = validateModel(built.model);
  const bpmn = await generateBpmn(built.model);
  const idef0 = generateIdef0(built.model);

  const session = createSession({ title: meta.processName, mode: "A", meta });
  updateSession(session.id, {
    model: built.model,
    validation,
    bpmnXml: bpmn.xml,
    idef0,
    status: "ready",
    diagramsStale: false,
    fragments: format === "image" ? [{ id: "diagram_image", index: 1, speaker: "owner", text: "(распознано с изображения)" }] : [],
  });
  logAudit(session.id, "analyst", "diagram_imported", { format, nodes: built.model.nodes.length });
  addVersion(session.id, `Импорт из диаграммы (${format})`);

  res.status(201).json({ session: getSession(session.id), warnings: built.warnings });
});
