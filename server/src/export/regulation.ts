import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import type { SessionRecord } from "../repo.js";
import { buildRegulation } from "../pipeline/regulation.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ФТ-М1.1.4: HTML-предпросмотр регламента с подсветкой устаревших абзацев. */
export function buildRegulationHtml(session: SessionRecord, opts?: { structureOnly?: boolean; staleIds?: Set<string> }): string {
  const model = session.model!;
  const paragraphs = buildRegulation(model, { structureOnly: opts?.structureOnly });
  const staleIds = opts?.staleIds ?? new Set<string>();

  const body = paragraphs
    .map((p) => {
      const staleClass = staleIds.has(p.id) ? " stale" : "";
      if (p.kind === "heading") return `<h2 class="sec${staleClass}">${esc(p.text)}</h2>`;
      const indentStyle = p.indent > 0 ? ` style="margin-left:${p.indent * 24}px"` : "";
      const tag = p.kind === "listItem" ? "p" : "p";
      return `<${tag} class="para${staleClass}"${indentStyle} data-plm-refs="${p.sourceRefs.join(",")}">${p.kind === "listItem" ? "— " : ""}${esc(p.text)}</${tag}>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Регламент — ${esc(session.meta.processName)}</title>
<style>
  body { font-family: "Times New Roman", Georgia, serif; color: #111827; margin: 0; padding: 32px 48px; line-height: 1.5; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .subtitle { text-align: center; color: #4b5563; font-size: 13px; margin-bottom: 28px; }
  h2.sec { font-size: 15px; margin-top: 26px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  p.para { font-size: 13px; margin: 6px 0; }
  .stale { background: #fef3c7; outline: 2px dashed #b45309; padding: 2px 6px; }
  .legend { font-size: 11px; color: #92400e; margin-top: 4px; }
</style>
</head>
<body>
  <h1>ПОЛОЖЕНИЕ О ПРОЦЕССЕ<br/>«${esc(session.meta.processName)}»</h1>
  <div class="subtitle">
    Версия ${esc(model.process.version)} · Статус: ${esc(model.process.status)} · Владелец: ${esc(session.meta.owner ?? "—")}
    ${staleIds.size > 0 ? `<div class="legend">Абзацев, устаревших после последней генерации: ${staleIds.size} (выделены жёлтым)</div>` : ""}
  </div>
  ${body}
</body>
</html>`;
}

/** ФТ-М1.1.1: экспорт регламента в реальный .docx (пакет docx, без внешнего шаблона — ФТ-М1.1.3 кастомизация шаблона не реализована). */
export async function buildRegulationDocx(session: SessionRecord, opts?: { structureOnly?: boolean }): Promise<Buffer> {
  const model = session.model!;
  const paragraphs = buildRegulation(model, { structureOnly: opts?.structureOnly });

  const children: Paragraph[] = [
    new Paragraph({
      text: `ПОЛОЖЕНИЕ О ПРОЦЕССЕ «${session.meta.processName}»`,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Версия ${model.process.version} · Статус: ${model.process.status}`, italics: true, size: 20 })],
    }),
  ];

  for (const p of paragraphs) {
    if (p.kind === "heading") {
      children.push(new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    } else {
      children.push(
        new Paragraph({
          indent: { left: p.indent * 360 },
          bullet: p.kind === "listItem" ? { level: 0 } : undefined,
          children: [new TextRun({ text: p.text })],
        })
      );
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
