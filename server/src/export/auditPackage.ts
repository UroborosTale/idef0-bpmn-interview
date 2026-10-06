import JSZip from "jszip";
import type { SessionRecord } from "../repo.js";
import type { ChecklistResult } from "../pipeline/checklist.js";
import { buildRegulation } from "../pipeline/regulation.js";
import { buildRegulationDocx } from "./regulation.js";
import { buildRaciWorkbookBuffer } from "../pipeline/raci.js";
import { renderBpmnSchematic } from "./album.js";

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ФТ-М6.4.1: единая HTML-обложка пакета к аудиту — паспорт процесса, чек-лист, RACI, регламент, диаграммы, история версий. */
export async function buildAuditPackageHtml(session: SessionRecord, checklist: ChecklistResult): Promise<string> {
  const m = session.model!;
  const bpmnSchematic = await renderBpmnSchematic(m);
  const regulationParagraphs = buildRegulation(m);

  const regulationHtml = regulationParagraphs
    .map((p) => {
      if (p.kind === "heading") return `<h3 class="reg-sec">${esc(p.text)}</h3>`;
      const indentStyle = p.indent > 0 ? ` style="margin-left:${p.indent * 24}px"` : "";
      return `<p class="reg-p"${indentStyle}>${p.kind === "listItem" ? "— " : ""}${esc(p.text)}</p>`;
    })
    .join("\n");

  const raciRows = m.nodes
    .filter((n) => n.type === "task" || n.type === "subprocess")
    .map((n) => {
      const cells = m.roles
        .map((r) => {
          const types = m.raci.filter((e) => e.node_id === n.id && e.role_id === r.id).map((e) => e.type);
          return `<td>${esc(types.join(","))}</td>`;
        })
        .join("");
      return `<tr><td>${esc(n.name)}</td>${cells}</tr>`;
    })
    .join("");

  const versionRows = session.versions
    .slice()
    .reverse()
    .map(
      (v) =>
        `<tr><td>${v.version}</td><td>${v.major ? "утверждение" : "черновик"}</td><td>${esc(v.ts)}</td><td>${esc(v.author)}</td><td>${esc(v.note)}</td></tr>`
    )
    .join("");

  const checklistRows = checklist.results
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td class="${r.passed ? "ok" : "fail"}">${r.passed ? "соответствует" : "не соответствует"}</td><td>${esc(r.detail)}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>${esc(session.meta.processName)} — пакет к аудиту</title>
<style>
  body { font-family: Arial, sans-serif; color: #111827; margin: 0; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 32px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  h3.reg-sec { font-size: 14px; margin-top: 16px; }
  p.reg-p { font-size: 12px; margin: 4px 0; font-family: "Times New Roman", Georgia, serif; }
  .meta { color: #4b5563; font-size: 13px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  .diagram { border: 1px solid #e5e7eb; padding: 8px; margin-top: 8px; }
  .ok { color: #166534; }
  .fail { color: #991b1b; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
  <h1>Пакет к аудиту: «${esc(session.meta.processName)}»</h1>
  <div class="meta">
    Версия: ${esc(m.process.version)} · Статус: ${esc(m.process.status)} · Владелец: ${esc(m.process.owner ?? "—")} · Подразделение: ${esc(session.meta.department ?? "—")}<br/>
    Дата формирования пакета: ${new Date().toISOString()} · Соответствие чек-листу: <span class="badge" style="background:${checklist.compliancePercent >= 80 ? "#dcfce7" : "#fee2e2"}">${checklist.compliancePercent}%</span>
  </div>

  <h2>Паспорт процесса</h2>
  <table><tbody>
    <tr><td>Цель</td><td>${esc(m.process.goal ?? "не выявлена")}</td></tr>
    <tr><td>Триггер</td><td>${esc(m.process.trigger ?? "не выявлен")}</td></tr>
    <tr><td>Результат</td><td>${esc(m.process.result ?? "не выявлен")}</td></tr>
    <tr><td>KPI</td><td>${m.process.kpi.map((k) => `${esc(k.name)}${k.target ? ` (цель: ${esc(k.target)})` : ""}`).join("; ") || "не определены"}</td></tr>
    <tr><td>Риски</td><td>${m.process.risks.map((r) => esc(r.name)).join("; ") || "не определены"}</td></tr>
  </tbody></table>

  <h2>Чек-лист процессного подхода</h2>
  <table><thead><tr><th>Правило</th><th>Статус</th><th>Пояснение</th></tr></thead><tbody>
    ${checklistRows || `<tr><td colspan="3">Нет включённых правил</td></tr>`}
  </tbody></table>

  <div class="page-break"></div>
  <h2>Схема процесса (BPMN)</h2>
  <div class="diagram">${bpmnSchematic}</div>

  <h2>Контекстная диаграмма IDEF0 (A-0)</h2>
  <div class="diagram">${session.idef0?.contextSvg ?? ""}</div>

  <div class="page-break"></div>
  <h2>Матрица ответственности (RACI)</h2>
  <table><thead><tr><th>Действие</th>${m.roles.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr></thead><tbody>
    ${raciRows}
  </tbody></table>

  <div class="page-break"></div>
  <h2>Текст регламента</h2>
  ${regulationHtml}

  <div class="page-break"></div>
  <h2>История версий</h2>
  <table><thead><tr><th>Версия</th><th>Тип</th><th>Дата</th><th>Автор</th><th>Комментарий</th></tr></thead><tbody>
    ${versionRows}
  </tbody></table>
</body>
</html>`;
}

/** ФТ-М6.4.2: полный пакет документов к аудиту в .zip (модель, диаграммы, регламент, RACI, чек-лист, история версий). */
export async function buildAuditPackageZip(session: SessionRecord, checklist: ChecklistResult): Promise<Buffer> {
  const m = session.model!;
  const zip = new JSZip();

  zip.file("model.json", JSON.stringify(m, null, 2));
  if (session.bpmnXml) zip.file("diagram.bpmn.xml", session.bpmnXml);
  if (session.idef0) {
    zip.file("idef0-context.svg", session.idef0.contextSvg);
    zip.file("idef0-decomposition.svg", session.idef0.decompositionSvg);
  }
  zip.file("checklist.json", JSON.stringify(checklist, null, 2));
  zip.file("versions.json", JSON.stringify(session.versions.map(({ model: _model, ...rest }) => rest), null, 2));
  zip.file("raci.xlsx", buildRaciWorkbookBuffer(m));
  zip.file("regulation.docx", await buildRegulationDocx(session));
  zip.file("cover.html", await buildAuditPackageHtml(session, checklist));

  return zip.generateAsync({ type: "nodebuffer" });
}
