import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import type { SessionRecord } from "../repo.js";
import { buildJobDescription, type RolePositionInfo } from "../pipeline/jobDescription.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ФТ-М1.2: HTML-предпросмотр должностной инструкции роли. */
export function buildJobDescriptionHtml(session: SessionRecord, roleId: string, position?: RolePositionInfo): string {
  const model = session.model!;
  const role = model.roles.find((r) => r.id === roleId);
  const paragraphs = buildJobDescription(model, roleId, position);

  const body = paragraphs
    .map((p) => {
      if (p.kind === "heading") return `<h2 class="sec">${esc(p.text)}</h2>`;
      return `<p class="para" data-plm-refs="${p.sourceRefs.join(",")}">${p.kind === "listItem" ? "— " : ""}${esc(p.text)}</p>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Должностная инструкция — ${esc(role?.name ?? roleId)}</title>
<style>
  body { font-family: "Times New Roman", Georgia, serif; color: #111827; margin: 0; padding: 32px 48px; line-height: 1.5; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .subtitle { text-align: center; color: #4b5563; font-size: 13px; margin-bottom: 28px; }
  h2.sec { font-size: 15px; margin-top: 26px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  p.para { font-size: 13px; margin: 6px 0; }
</style>
</head>
<body>
  <h1>ДОЛЖНОСТНАЯ ИНСТРУКЦИЯ<br/>«${esc(role?.name ?? roleId)}»</h1>
  <div class="subtitle">Процесс «${esc(session.meta.processName)}» · Версия ${esc(model.process.version)}</div>
  ${body}
</body>
</html>`;
}

/** ФТ-М1.2: экспорт должностной инструкции в .docx. */
export async function buildJobDescriptionDocx(session: SessionRecord, roleId: string, position?: RolePositionInfo): Promise<Buffer> {
  const model = session.model!;
  const role = model.roles.find((r) => r.id === roleId);
  const paragraphs = buildJobDescription(model, roleId, position);

  const children: Paragraph[] = [
    new Paragraph({ text: `ДОЛЖНОСТНАЯ ИНСТРУКЦИЯ «${role?.name ?? roleId}»`, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Процесс «${session.meta.processName}» · Версия ${model.process.version}`, italics: true, size: 20 })],
    }),
  ];

  for (const p of paragraphs) {
    if (p.kind === "heading") {
      children.push(new Paragraph({ text: p.text, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    } else {
      children.push(new Paragraph({ bullet: p.kind === "listItem" ? { level: 0 } : undefined, children: [new TextRun({ text: p.text })] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
