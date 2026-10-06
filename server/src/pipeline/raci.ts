import * as XLSX from "xlsx";
import type { ProcessLogicModel, RaciEntry } from "../types/model.js";

/**
 * Автопостроение матрицы RACI (ФТ-М1.3.1): исполнитель действия (role_id
 * узла) получает R. Роли A/C/I предлагаются по маркерам в тексте цитат
 * источника узла — «утверждает» → A, «согласовывает» → C,
 * «уведомляется»/«информируется» → I. Если ни один маркер A не сработал,
 * по умолчанию исполнитель (R) считается и ответственным (A) за свой шаг.
 */
export const APPROVE_STEMS = ["утвержда", "утверд", "подписыва", "подпис", "принима решение", "одобря", "одобр"];
export const CONSULT_STEMS = ["согласовыва", "согласов", "консультир", "визиру", "советуется"];
const INFORM_STEMS = ["уведомля", "уведом", "информир", "сообща", "оповещ"];

function findRoleIdInText(text: string, roles: ProcessLogicModel["roles"], exclude?: string | null): string | null {
  const lower = text.toLowerCase();
  for (const r of roles) {
    if (r.id === exclude) continue;
    if (lower.includes(r.name.toLowerCase())) return r.id;
  }
  return null;
}

export function buildRaci(model: ProcessLogicModel): RaciEntry[] {
  const entries: RaciEntry[] = [];
  const seen = new Set<string>();
  const add = (node_id: string, role_id: string, type: RaciEntry["type"]) => {
    const key = `${node_id}:${role_id}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ node_id, role_id, type });
  };

  for (const n of model.nodes) {
    if (n.type !== "task" && n.type !== "subprocess") continue;
    if (n.role_id) add(n.id, n.role_id, "R");

    const text = n.source.map((s) => s.quote).join(" ").toLowerCase();
    let foundA = false;
    if (APPROVE_STEMS.some((s) => text.includes(s))) {
      const roleId = findRoleIdInText(text, model.roles) ?? n.role_id;
      if (roleId) {
        add(n.id, roleId, "A");
        foundA = true;
      }
    }
    if (CONSULT_STEMS.some((s) => text.includes(s))) {
      const roleId = findRoleIdInText(text, model.roles, n.role_id);
      if (roleId) add(n.id, roleId, "C");
    }
    if (INFORM_STEMS.some((s) => text.includes(s))) {
      const roleId = findRoleIdInText(text, model.roles, n.role_id);
      if (roleId) add(n.id, roleId, "I");
    }
    if (!foundA && n.role_id) add(n.id, n.role_id, "A");
  }
  return entries;
}

/** ФТ-М1.3.3/М6.4: матрица RACI как .xlsx-буфер (строки — действия, столбцы — роли) — используется и отдельной выгрузкой, и пакетом к аудиту. */
export function buildRaciWorkbookBuffer(model: ProcessLogicModel): Buffer {
  const tasks = model.nodes.filter((n) => n.type === "task" || n.type === "subprocess");
  const sheetRows = tasks.map((n) => {
    const row: Record<string, string> = { Действие: n.name };
    for (const r of model.roles) {
      const types = model.raci.filter((e) => e.node_id === n.id && e.role_id === r.id).map((e) => e.type);
      row[r.name] = types.join(",");
    }
    return row;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  ws["!cols"] = [{ wch: 40 }, ...model.roles.map(() => ({ wch: 14 }))];
  XLSX.utils.book_append_sheet(wb, ws, "RACI");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
