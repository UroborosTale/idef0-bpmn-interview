import type { ProcessLogicModel } from "../types/model.js";

export type JobDescriptionSectionKey = "general" | "duties" | "interactions" | "documents";

export interface JobDescriptionParagraph {
  id: string;
  section: JobDescriptionSectionKey;
  kind: "heading" | "paragraph" | "listItem";
  text: string;
  sourceRefs: string[];
}

export const JD_SECTION_LABELS: Record<JobDescriptionSectionKey, string> = {
  general: "1. Общие положения",
  duties: "2. Должностные обязанности",
  interactions: "3. Взаимодействие",
  documents: "4. Используемые документы и данные",
};

const RACI_LABEL: Record<string, string> = { R: "исполняет", A: "несёт ответственность за", C: "согласовывает", I: "уведомляется о результате" };

function heading(section: JobDescriptionSectionKey): JobDescriptionParagraph {
  return { id: `${section}-heading`, section, kind: "heading", text: JD_SECTION_LABELS[section], sourceRefs: [] };
}

export interface RolePositionInfo {
  title: string | null;
  department: string | null;
}

/** ФТ-М1.2: должностная инструкция для роли в процессе, построенная из RACI/задач модели. */
export function buildJobDescription(model: ProcessLogicModel, roleId: string, position?: RolePositionInfo): JobDescriptionParagraph[] {
  const role = model.roles.find((r) => r.id === roleId);
  if (!role) return [];

  const dataById = new Map(model.data.map((d) => [d.id, d.name] as const));
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");

  const general: JobDescriptionParagraph[] = [heading("general")];
  general.push({
    id: "general-role",
    section: "general",
    kind: "paragraph",
    text: `Настоящая должностная инструкция определяет обязанности роли «${role.name}» в процессе «${model.process.name}».`,
    sourceRefs: [role.id],
  });
  if (position?.title) {
    general.push({ id: "general-position", section: "general", kind: "paragraph", text: `Соответствующая должность по штатному расписанию: ${position.title}${position.department ? ` (${position.department})` : ""}.`, sourceRefs: [role.id] });
  }
  general.push({ id: "general-kind", section: "general", kind: "paragraph", text: `Тип роли: ${role.kind === "internal" ? "внутренний сотрудник" : "внешняя сторона"}.`, sourceRefs: [role.id] });

  const duties: JobDescriptionParagraph[] = [heading("duties")];
  const interactions: JobDescriptionParagraph[] = [heading("interactions")];
  const usedDataIds = new Set<string>();

  for (const n of tasks) {
    const entries = model.raci.filter((r) => r.node_id === n.id && r.role_id === roleId);
    const direct = n.role_id === roleId;
    const isDutyHolder = entries.some((e) => e.type === "R" || e.type === "A") || (direct && entries.length === 0);
    const isInteractor = entries.some((e) => e.type === "C" || e.type === "I");

    if (isDutyHolder) {
      const raciTypes = entries.filter((e) => e.type === "R" || e.type === "A").map((e) => RACI_LABEL[e.type]);
      const label = raciTypes.length > 0 ? raciTypes.join(", ") : "исполняет";
      duties.push({ id: `duty-${n.id}`, section: "duties", kind: "listItem", text: `${label}: «${n.name}».`, sourceRefs: [n.id] });
      for (const id of n.inputs) usedDataIds.add(id);
      for (const id of n.outputs) usedDataIds.add(id);
    } else if (isInteractor) {
      const raciTypes = entries.filter((e) => e.type === "C" || e.type === "I").map((e) => RACI_LABEL[e.type]);
      interactions.push({ id: `inter-${n.id}`, section: "interactions", kind: "listItem", text: `«${n.name}»: ${raciTypes.join(", ")}.`, sourceRefs: [n.id] });
    }
  }
  if (duties.length === 1) duties.push({ id: "duties-empty", section: "duties", kind: "paragraph", text: "Обязанности в рамках данного процесса не выявлены.", sourceRefs: [] });
  if (interactions.length === 1) interactions.push({ id: "inter-empty", section: "interactions", kind: "paragraph", text: "Дополнительное взаимодействие (согласование/уведомление) не выявлено.", sourceRefs: [] });

  const documents: JobDescriptionParagraph[] = [heading("documents")];
  for (const dataId of usedDataIds) {
    const name = dataById.get(dataId);
    if (name) documents.push({ id: `doc-${dataId}`, section: "documents", kind: "listItem", text: name, sourceRefs: [dataId] });
  }
  if (documents.length === 1) documents.push({ id: "documents-empty", section: "documents", kind: "paragraph", text: "Документы/данные не выявлены.", sourceRefs: [] });

  return [...general, ...duties, ...interactions, ...documents];
}
