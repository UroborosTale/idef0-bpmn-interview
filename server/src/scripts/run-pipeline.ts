/**
 * Разбор текста интервью конвейером без веб-приложения.
 *
 *   npx tsx src/scripts/run-pipeline.ts <id сессии>            — прогнать конвейер по тексту сессии и сохранить модель
 *   npx tsx src/scripts/run-pipeline.ts --file text.txt        — разобрать текст из файла (сессия не создаётся)
 *   ... --depth 1|2|both                                       — глубина декомпозиции (both — сравнить на одном тексте)
 *   ... --name "Согласование договора"                         — название процесса (по умолчанию — имя файла)
 *
 * Подстройка правил промпта: запускать один и тот же текст с `--depth 1` и `--depth 2` (или `both`) и смотреть,
 * где структура ближе к Соглашению — подпроцессы не мельче двух операций, операции не мельче двух действий.
 * Если сеть подменяет TLS, нужен NODE_EXTRA_CA_CERTS (см. docs/desktop-setup.md).
 */
import fs from "node:fs";
import path from "node:path";
import "../env.js";
import { getSession, updateSession } from "../repo.js";
import { runPipeline, type PipelineOutput } from "../pipeline/run.js";
import { fragmentText } from "../pipeline/fragment.js";
import type { ExtractionChunkResult, LLMProvider } from "../llm/types.js";
import type { Fragment, ProcessLogicModel } from "../types/model.js";

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = argOf("--file");
const depthArg = argOf("--depth") ?? "2";
const extractionFile = argOf("--extraction");
const saveTo = argOf("--save-to");
const sessionId = file ? undefined : argv.find((a) => !a.startsWith("--"));

const emptyChunk: ExtractionChunkResult = {
  roles: [],
  systems: [],
  data: [],
  controls: [],
  operations: [],
  subprocesses: [],
  nodes: [],
  flows: [],
  statements: [],
  process_hints: {},
};

/** Провайдер-заглушка: извлечение берётся из файла (аналитик или LLM-агент сделали его вручную), остальной конвейер — прежний. */
function fixtureProvider(result: ExtractionChunkResult): LLMProvider {
  let calls = 0;
  return {
    name: "fixture (извлечение из файла)",
    extractChunk: async () => (calls++ === 0 ? result : emptyChunk),
  };
}

interface Structure {
  subs: { name: string; ops: { name: string; steps: string[] }[] }[];
  loose: { name: string; steps: string[] }[];
  looseSteps: string[];
}

function structureOf(m: ProcessLogicModel): Structure {
  const isFn = (n: ProcessLogicModel["nodes"][number]) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope;
  const steps = (id: string) => m.nodes.filter((n) => n.bpmn_scope === id).map((n) => n.name);
  const fns = m.nodes.filter(isFn);
  const subs = fns
    .filter((n) => !n.idef0_parent && fns.some((k) => k.idef0_parent === n.id))
    .map((n) => ({ name: n.name, ops: fns.filter((k) => k.idef0_parent === n.id).map((k) => ({ name: k.name, steps: steps(k.id) })) }));
  const inSub = new Set(subs.flatMap((s) => s.ops.map((o) => o.name)));
  const loose = fns.filter((n) => !n.idef0_parent && !subs.some((s) => s.name === n.name) && !inSub.has(n.name)).map((n) => ({ name: n.name, steps: steps(n.id) }));
  const scopes = new Set(fns.map((n) => n.id));
  const looseSteps = m.nodes.filter((n) => !n.bpmn_scope && (n.type === "event" || n.type === "gateway" || !isFn(n))).map((n) => n.name);
  void scopes;
  return { subs, loose, looseSteps };
}

function printStructure(m: ProcessLogicModel, label: string): void {
  const s = structureOf(m);
  const ops = s.subs.flatMap((x) => x.ops).concat(s.loose);
  const single = ops.filter((o) => o.steps.length === 1).length;
  const empty = ops.filter((o) => o.steps.length === 0).length;
  console.log(`\n=== ${label} ===`);
  for (const sub of s.subs) {
    console.log(`подпроцесс «${sub.name}» — операций ${sub.ops.length}`);
    for (const op of sub.ops) console.log(`   • ${op.name} — шагов ${op.steps.length}${op.steps.length ? `: ${op.steps.join("; ")}` : ""}`);
  }
  for (const op of s.loose) console.log(`операция «${op.name}» (уровень 0) — шагов ${op.steps.length}${op.steps.length ? `: ${op.steps.join("; ")}` : ""}`);
  console.log(`итого: подпроцессов ${s.subs.length}, операций ${ops.length} (с одним действием ${single}, без действий ${empty}), действий общей схемы ${s.looseSteps.length}, шагов в операциях ${m.nodes.filter((n) => n.bpmn_scope).length}, пробелов ${m.gaps.length}`);
}

async function runOne(label: string, fragments: Fragment[], id: string, name: string, depth: number): Promise<PipelineOutput> {
  const meta = { processName: name, modelType: "AS-IS" as const, decompositionDepth: depth, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };
  const extraction = extractionFile ? (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), extractionFile), "utf-8")) as ExtractionChunkResult) : undefined;
  const t0 = Date.now();
  const output = await runPipeline(id, fragments, meta as never, extraction ? { provider: fixtureProvider(extraction) } : {});
  console.log(`\n[${label}] провайдер ${output.providerName}, ${Math.round((Date.now() - t0) / 1000)} с, необработанных частей ${output.report.failedChunks.length}, цитат не найдено ${output.report.unverified}, гипотез ${output.model.nodes.filter((n) => n.status === "hypothesis").length}, ошибок ${output.validation.filter((v) => v.severity === "error").length}, предупреждений ${output.validation.filter((v) => v.severity === "warning").length}`);
  printStructure(output.model, label);
  return output;
}

if (file) {
  const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
  const fragments = fragmentText(text);
  const name = argOf("--name") ?? path.basename(file).replace(/\.(txt|md)$/i, "");
  console.log(`файл ${file}: ${text.length} знаков, фрагментов ${fragments.length}, процесс «${name}»`);
  const depths = depthArg === "both" ? [1, 2] : [Number(depthArg) || 2];
  let last: PipelineOutput | undefined;
  for (const d of depths) last = await runOne(`глубина ${d}`, fragments, `cli_${Date.now()}`, name, d);
  if (saveTo && last) {
    updateSession(saveTo, { model: last.model, validation: last.validation, bpmnXml: last.bpmnXml, idef0: last.idef0, status: "ready" });
    console.log(`модель сохранена в сессию ${saveTo}`);
  }
} else {
  if (!sessionId) throw new Error("Укажите id сессии или --file <путь к тексту>");
  const session = getSession(sessionId);
  if (!session) throw new Error(`нет сессии ${sessionId}`);
  const output = await runOne(`сессия ${sessionId}`, session.fragments, session.id, session.meta.processName, session.meta.decompositionDepth ?? 2);
  updateSession(session.id, { model: output.model, validation: output.validation, bpmnXml: output.bpmnXml, idef0: output.idef0, status: "ready" });
  console.log(`модель сохранена в сессию ${session.id}`);
}
