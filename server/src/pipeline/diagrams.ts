import { generateBpmn } from "./bpmn.js";
import { generateIdef0 } from "./idef0.js";
import { updateSession, type SessionRecord } from "../repo.js";

/**
 * Свежие диаграммы для выгрузки. После правки модели (`PUT /model`, «Правки из редакторов», RACI) в сессии стоит
 * diagramsStale, а кэш bpmnXml/idef0 остаётся прежним: выгрузки .bpmn и .svg отдавали старую схему, хотя .vsdx,
 * альбом и печать строились по текущей модели. Перед выгрузкой пересобираем и запоминаем — дальше кэш актуален.
 */
export async function ensureDiagrams(session: SessionRecord): Promise<SessionRecord> {
  if (!session.model) return session;
  if (!session.diagramsStale && session.bpmnXml && session.idef0) return session;
  const bpmn = await generateBpmn(session.model);
  const idef0 = generateIdef0(session.model);
  return updateSession(session.id, { bpmnXml: bpmn.xml, idef0, diagramsStale: false });
}
