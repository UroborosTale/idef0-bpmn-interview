import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { AgentQuestion } from "../agentQuestions.js";
import type { AgentReport } from "../agentReports.js";
import type { SessionRecord } from "../repo.js";
import { functionCodes, stepCodes } from "../shared/codes.js";
import { innerQuotes } from "../shared/quote.js";

/** Word-документы из хранилища агентов: лист вопросов к интервью (с полем для записи ответа) и отчёт аналитика. */

const PRIORITY: Record<string, string> = { critical: "Критично", important: "Важно", desirable: "Желательно" };
const LEVEL: Record<string, string> = { high: "высокое", medium: "среднее", low: "низкое" };
const KIND: Record<string, string> = { analysis: "анализ", review: "проверка", methodology: "методология", other: "прочее" };
const RANK: Record<string, number> = { critical: 0, important: 1, desirable: 2 };

const cell = (text: string, opts: { bold?: boolean; width?: number } = {}) =>
  new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, size: 20 })] })],
  });

const table = (head: string[], widths: number[], rows: string[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { bold: true, width: widths[i] })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, { width: widths[i] })) })),
    ],
  });

const meta = (text: string) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, italics: true, size: 20 })] });
const today = () => new Date().toISOString().slice(0, 10);

/** Код и название функции по id; процесс в целом — без кода. */
function labeler(session: SessionRecord) {
  const model = session.model;
  const codes = model ? new Map([...functionCodes(model), ...stepCodes(model)]) : new Map<string, string>();
  return (nodeId: string | null): { code: string; label: string } => {
    if (!nodeId) return { code: "", label: "Процесс в целом" };
    const name = model?.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
    const code = codes.get(nodeId) ?? "";
    return { code, label: code ? `${code} «${name}»` : `«${name}»` };
  };
}

/**
 * Лист вопросов к интервью: ждущие и заданные вопросы по функциям в порядке кодов, внутри — по важности. В таблице колонка
 * «Ответ» оставлена пустой — для записи на бумаге. Отвеченные и снятые вопросы в лист не попадают.
 */
export async function buildQuestionsDocx(session: SessionRecord, questions: AgentQuestion[]): Promise<Buffer> {
  const label = labeler(session);
  const live = questions.filter((q) => q.status === "open" || q.status === "asked");
  const groups = new Map<string, { label: string; code: string; items: AgentQuestion[] }>();
  for (const q of live) {
    const l = label(q.scopeNodeId);
    const g = groups.get(l.label) ?? { ...l, items: [] };
    g.items.push(q);
    groups.set(l.label, g);
  }
  // процесс в целом — первым, дальше по кодам (B002.01.02 сортируется как строка: коды одной длины)
  const ordered = [...groups.values()].sort((a, b) => (a.code === "" ? -1 : b.code === "" ? 1 : a.code.localeCompare(b.code)));

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: "ЛИСТ ВОПРОСОВ К ИНТЕРВЬЮ", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    meta(`Процесс «${innerQuotes(session.meta.processName)}»${session.meta.owner ? ` · владелец: ${session.meta.owner}` : ""} · ${today()}`),
  ];
  if (live.length === 0) children.push(new Paragraph({ spacing: { before: 300 }, children: [new TextRun("Ждущих вопросов нет.")] }));
  let n = 0;
  for (const g of ordered) {
    children.push(new Paragraph({ text: g.label, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } }));
    const rows = g.items
      .sort((a, b) => RANK[a.priority] - RANK[b.priority])
      .map((q) => [String(++n), q.text, q.addressee ?? "", PRIORITY[q.priority], q.reason ?? "", ""]);
    children.push(table(["№", "Вопрос", "Кого спросить", "Важность", "Зачем", "Ответ"], [4, 30, 14, 10, 18, 24], rows));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

/** Отчёт агента: сводка, таблица выводов и полный текст (строки «# …» — заголовки). */
export async function buildReportDocx(session: SessionRecord, report: AgentReport): Promise<Buffer> {
  const label = labeler(session);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: report.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    meta(`Процесс «${innerQuotes(session.meta.processName)}» · ${KIND[report.kind] ?? report.kind} · агент: ${report.agent} · ${report.createdAt.slice(0, 10)}${report.scopeNodeId ? ` · ${label(report.scopeNodeId).label}` : ""}`),
  ];
  if (report.summary) children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: report.summary, bold: true })] }));
  if (report.findings.length > 0) {
    children.push(new Paragraph({ text: "Выводы", heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    children.push(
      table(
        ["№", "Влияние", "Вывод", "Где", "Основание", "Уверенность", "Рекомендация"],
        [4, 9, 25, 10, 20, 11, 21],
        report.findings.map((f, i) => [String(i + 1), LEVEL[f.impact] ?? f.impact, f.what, f.where ?? "", f.basis ?? "", LEVEL[f.confidence] ?? f.confidence, f.recommendation ?? ""])
      )
    );
  }
  if (report.body) {
    children.push(new Paragraph({ text: "Подробно", heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    for (const line of report.body.split(/\r?\n/)) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) children.push(new Paragraph({ text: h[2], heading: h[1].length === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, spacing: { before: 200, after: 80 } }));
      else if (/^\s*[-*]\s+/.test(line)) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(line.replace(/^\s*[-*]\s+/, ""))] }));
      else if (line.trim()) children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}