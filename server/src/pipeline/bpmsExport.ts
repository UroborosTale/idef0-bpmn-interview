import type { ProcessLogicModel, ProcessNode } from "../types/model.js";
import { parseDurationToMinutes } from "./timeUtils.js";

/**
 * ФТ-М1.4: экспорт конфигурации в BPMS. Целевые системы — Camunda
 * (исполняемый BPMN с расширениями camunda:) и ELMA365. Формат ELMA365 в
 * ТЗ помечен как "уточняется на этапе исследования" — его публичная схема
 * импорта процессов недоступна в этом окружении, поэтому экспортируется
 * общий JSON (сущности процесса в разумной универсальной структуре),
 * который требует ручного сопоставления полей при реальном внедрении;
 * это явно указано в отчёте о неполноте (1.4.3). Camunda-экспорт, напротив,
 * полностью рабочий: собственный BPMN-генератор (pipeline/bpmn.ts) уже
 * производит валидный BPMN 2.0, здесь он расширяется camunda:-атрибутами.
 */

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function taskTag(subtype?: string): string {
  switch (subtype) {
    case "service":
      return "serviceTask";
    case "manual":
      return "manualTask";
    case "send":
      return "sendTask";
    case "receive":
      return "receiveTask";
    case "script":
      return "scriptTask";
    default:
      return "userTask"; // по умолчанию — задача с исполнителем, наиболее частый случай в извлечённых моделях
  }
}
function gatewayTag(subtype?: string): string {
  switch (subtype) {
    case "parallel":
      return "parallelGateway";
    case "inclusive":
      return "inclusiveGateway";
    case "event_based":
      return "eventBasedGateway";
    default:
      return "exclusiveGateway";
  }
}

/** Минуты -> ISO 8601 длительность (PnDTnHnM), формат timeDuration Camunda. */
function minutesToIso8601(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.round(minutes % 60);
  let out = "P";
  if (days > 0) out += `${days}D`;
  if (hours > 0 || mins > 0) {
    out += "T";
    if (hours > 0) out += `${hours}H`;
    if (mins > 0) out += `${mins}M`;
  }
  return out === "P" ? "PT0M" : out;
}

export interface BpmsExportResult {
  xml: string;
  completenessNotes: string[];
}

/** ФТ-М1.4.1/1.4.2: исполняемый BPMN с расширениями Camunda — исполнители (группы), черновики форм, таймеры, условия-заглушки. */
export function buildCamundaBpmn(model: ProcessLogicModel): BpmsExportResult {
  const notes: string[] = [];
  const nodeIdOf = (mid: string) => `Node_${mid}`;
  const roleById = new Map(model.roles.map((r) => [r.id, r] as const));
  const dataById = new Map(model.data.map((d) => [d.id, d] as const));

  const flowElementsXml: string[] = [];

  for (const n of model.nodes) {
    const id = nodeIdOf(n.id);
    if (n.type === "task" || n.type === "subprocess") {
      const tag = n.type === "subprocess" ? "subProcess" : taskTag(n.subtype);
      const role = n.role_id ? roleById.get(n.role_id) : null;
      const assigneeAttr = role ? ` camunda:candidateGroups="${esc(role.name)}"` : "";
      if (!role) notes.push(`Задача «${n.name}»: не назначен исполнитель (роль) — требуется указать candidateGroups вручную.`);

      let formDataXml = "";
      if (tag === "userTask" && n.inputs.length > 0) {
        const fields = n.inputs
          .map((did) => {
            const d = dataById.get(did);
            return d ? `<camunda:formField id="${esc(d.id)}" label="${esc(d.name)}" type="string" />` : "";
          })
          .join("");
        formDataXml = `<bpmn:extensionElements><camunda:formData>${fields}</camunda:formData></bpmn:extensionElements>`;
      } else if (tag === "userTask") {
        notes.push(`Задача «${n.name}»: нет входных данных — черновик формы не сформирован, поля нужно добавить вручную.`);
      }
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}"${assigneeAttr}>${formDataXml}</bpmn:${tag}>`);
    } else if (n.type === "gateway") {
      const tag = gatewayTag(n.subtype);
      flowElementsXml.push(`<bpmn:${tag} id="${id}" name="${esc(n.name)}" />`);
    } else if (n.type === "event") {
      if (n.subtype === "start") {
        flowElementsXml.push(`<bpmn:startEvent id="${id}" name="${esc(n.name)}" />`);
      } else if (n.subtype === "end") {
        flowElementsXml.push(`<bpmn:endEvent id="${id}" name="${esc(n.name)}" />`);
      } else if (n.subtype === "timer") {
        const minutes = parseDurationToMinutes(n.duration);
        if (minutes) {
          flowElementsXml.push(
            `<bpmn:intermediateCatchEvent id="${id}" name="${esc(n.name)}"><bpmn:timerEventDefinition><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">${minutesToIso8601(
              minutes
            )}</bpmn:timeDuration></bpmn:timerEventDefinition></bpmn:intermediateCatchEvent>`
          );
        } else {
          notes.push(`Таймер «${n.name}»: не указан срок — таймер экспортирован без длительности, требуется задать вручную.`);
          flowElementsXml.push(`<bpmn:intermediateCatchEvent id="${id}" name="${esc(n.name)}"><bpmn:timerEventDefinition /></bpmn:intermediateCatchEvent>`);
        }
      } else {
        flowElementsXml.push(`<bpmn:intermediateThrowEvent id="${id}" name="${esc(n.name)}" />`);
      }
    }
  }

  const outAdj = new Map<string, number>();
  for (const f of model.flows) outAdj.set(f.from, (outAdj.get(f.from) ?? 0) + 1);
  for (const f of model.flows) {
    const fromNode = model.nodes.find((n) => n.id === f.from);
    const isBranchingGateway = fromNode?.type === "gateway" && (outAdj.get(f.from) ?? 0) > 1;
    let condXml = "";
    if (f.condition) {
      if (isBranchingGateway) {
        // ФТ-М1.4.2: условие шлюза как выражение-заглушка — реальная бизнес-логика ("f.condition")
        // требует ручного переноса в реальное JUEL/FEEL выражение.
        const varName = `cond_${f.id}`;
        condXml = `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${${varName}}</bpmn:conditionExpression>`;
        notes.push(`Условие ветвления «${f.condition}» (переход ${f.id}) экспортировано как заглушка "\${${varName}}" — нужно связать с реальной переменной процесса.`);
      } else {
        condXml = `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(f.condition)}</bpmn:conditionExpression>`;
      }
    }
    flowElementsXml.push(
      `<bpmn:sequenceFlow id="Flow_${f.id}" sourceRef="${nodeIdOf(f.from)}" targetRef="${nodeIdOf(f.to)}"${f.condition ? ` name="${esc(f.condition)}"` : ""}>${condXml}</bpmn:sequenceFlow>`
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_${esc(model.process.id)}" targetNamespace="http://example.org/bpmn" exporter="IDEF0-BPMN Interview System" exporterVersion="1.0">
  <bpmn:process id="Process_${esc(model.process.id)}" name="${esc(model.process.name)}" isExecutable="true">
    ${flowElementsXml.join("\n    ")}
  </bpmn:process>
</bpmn:definitions>
`;

  return { xml, completenessNotes: notes };
}

export interface Elma365Task {
  id: string;
  name: string;
  type: string;
  assigneeGroup: string | null;
  formFields: { id: string; label: string }[];
}
export interface Elma365Export {
  process: { id: string; name: string; owner: string | null };
  tasks: Elma365Task[];
  transitions: { id: string; from: string; to: string; conditionStub: string | null }[];
}

/** ФТ-М1.4.1: экспорт для ELMA365 — общий JSON (формат импорта процессов ELMA365 не документирован публично, требует сопоставления полей вручную при реальном внедрении). */
export function buildElma365Export(model: ProcessLogicModel): { data: Elma365Export; completenessNotes: string[] } {
  const notes: string[] = ["Формат ELMA365 не документирован публично в этом окружении — структура ниже общая (процесс/задачи/переходы) и требует сопоставления полей вручную при реальном импорте."];
  const roleById = new Map(model.roles.map((r) => [r.id, r] as const));
  const dataById = new Map(model.data.map((d) => [d.id, d] as const));

  const tasks: Elma365Task[] = model.nodes
    .filter((n) => n.type === "task" || n.type === "subprocess")
    .map((n: ProcessNode) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      assigneeGroup: n.role_id ? roleById.get(n.role_id)?.name ?? null : null,
      formFields: n.inputs.map((did) => ({ id: did, label: dataById.get(did)?.name ?? did })),
    }));

  const transitions = model.flows.map((f) => ({ id: f.id, from: f.from, to: f.to, conditionStub: f.condition ?? null }));

  return {
    data: { process: { id: model.process.id, name: model.process.name, owner: model.process.owner ?? null }, tasks, transitions },
    completenessNotes: notes,
  };
}

export interface CompletenessReport {
  target: "camunda" | "elma365";
  notes: string[];
  stats: { totalTasks: number; tasksWithoutAssignee: number; gatewaysWithConditionStubs: number };
}

/** ФТ-М1.4.3: сводный отчёт о неполноте — что требует ручной доработки перед реальным запуском в BPMS. */
export function buildCompletenessReport(model: ProcessLogicModel, target: "camunda" | "elma365", notes: string[]): CompletenessReport {
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");
  const tasksWithoutAssignee = tasks.filter((n) => !n.role_id).length;
  const outAdj = new Map<string, number>();
  for (const f of model.flows) outAdj.set(f.from, (outAdj.get(f.from) ?? 0) + 1);
  const gatewaysWithConditionStubs = model.nodes.filter((n) => n.type === "gateway" && (outAdj.get(n.id) ?? 0) > 1).length;
  return { target, notes, stats: { totalTasks: tasks.length, tasksWithoutAssignee, gatewaysWithConditionStubs } };
}
