import { ProcessLogicModel } from "../src/types/model.js";

const task = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: "task", name, ...extra });

/** Закупка: три функции верхнего уровня, у второй — две вложенные, выход B управляет C. */
export function purchaseModel(): ProcessLogicModel {
  return ProcessLogicModel.parse({
    process: { id: "p", name: "Закупка" },
    roles: [{ id: "r1", name: "Инициатор" }, { id: "r2", name: "Бухгалтер" }],
    data: [{ id: "d1", name: "заявка" }, { id: "d2", name: "счёт" }, { id: "d3", name: "решение" }, { id: "d4", name: "оплата" }],
    controls: [{ id: "c1", name: "регламент закупок" }],
    systems: [{ id: "s1", name: "1С" }],
    nodes: [
      task("a", "оформить заявку", { outputs: ["d1"], controls: ["c1"], role_id: "r1" }),
      task("b", "согласовать заявку", { inputs: ["d1"], outputs: ["d3"], controls: ["c1"], role_id: "r1" }),
      task("c", "оплатить счёт", { inputs: ["d2"], control_data_ids: ["d3"], outputs: ["d4"], role_id: "r2", system_ids: ["s1"] }),
      task("b1", "проверить бюджет", { idef0_parent: "b", inputs: ["d1"], controls: ["c1"] }),
      task("b2", "принять решение", { idef0_parent: "b", outputs: ["d3"], controls: ["c1"] }),
    ],
    flows: [{ id: "f1", from: "a", to: "b" }, { id: "f2", from: "b", to: "c" }, { id: "f3", from: "b1", to: "b2" }],
  });
}

/** Процесс с явными событиями, шлюзом и двумя ветками в одной дорожке. */
export function branchingModel(): ProcessLogicModel {
  return ProcessLogicModel.parse({
    process: { id: "q", name: "Проверка договора" },
    roles: [{ id: "r1", name: "Юрист" }, { id: "r2", name: "Менеджер" }],
    nodes: [
      { id: "s", type: "event", subtype: "start", name: "Договор получен" },
      task("t1", "проверить договор", { role_id: "r1" }),
      { id: "g", type: "gateway", subtype: "exclusive", name: "Есть замечания?", role_id: "r1" },
      task("t2", "вернуть на доработку", { role_id: "r1" }),
      task("t3", "подписать договор", { role_id: "r1" }),
      task("t4", "уведомить клиента", { role_id: "r2" }),
      { id: "e", type: "event", subtype: "end", name: "Договор обработан" },
    ],
    flows: [
      { id: "f1", from: "s", to: "t1" },
      { id: "f2", from: "t1", to: "g" },
      { id: "f3", from: "g", to: "t2", condition: "да" },
      { id: "f4", from: "g", to: "t3", condition: "нет" },
      { id: "f5", from: "t2", to: "t1" },
      { id: "f6", from: "t3", to: "t4" },
      { id: "f7", from: "t4", to: "e" },
    ],
  });
}

/**
 * Модель по структуре Соглашения о моделировании: процесс B002.00.00, два подпроцесса, три операции,
 * у первой операции — диаграмма BPMN (старт, две задачи, конец), ролевая модель и продукты.
 */
export function structuredModel(): ProcessLogicModel {
  return ProcessLogicModel.parse({
    process: { id: "p", name: "Управление процессами", code: "B002.00.00" },
    roles: [
      { id: "r1", name: "Начальник отдела корпоративных технологий" },
      { id: "r2", name: "Специалист отдела корпоративных технологий", qualification: "Опыт моделирования от 1 года" },
      { id: "r3", name: "Директор по персоналу" },
    ],
    data: [
      { id: "d1", name: "Информация о выявленном процессе" },
      { id: "d2", name: "Актуальный реестр процессов" },
      { id: "d3", name: "Протокол интервью" },
      { id: "d4", name: "Информация об эффективности" },
    ],
    controls: [{ id: "c1", name: "СТП 113-01-2025" }],
    systems: [{ id: "s1", name: "ELMA365" }],
    nodes: [
      task("s1", "Моделирование процесса", { inputs: ["d1"], outputs: ["d3"], controls: ["c1"] }),
      task("s2", "Анализ эффективности процессной модели", { inputs: ["d3"], outputs: ["d4"], controls: ["c1"] }),
      task("o1", "Актуализация реестра процессов", { idef0_parent: "s1", inputs: ["d1"], outputs: ["d2"], controls: ["c1"], role_id: "r2" }),
      task("o2", "Проведение первичного интервью", { idef0_parent: "s1", inputs: ["d2"], outputs: ["d3"], controls: ["c1"] }),
      task("o3", "Анализ соответствия", { idef0_parent: "s2", inputs: ["d3"], outputs: ["d4"], controls: ["c1"], role_id: "r2" }),
      { id: "b0", type: "event", subtype: "start", name: "Информация получена", bpmn_scope: "o1", role_id: "r2" },
      task("b1", "Открыть реестр", { bpmn_scope: "o1", role_id: "r2", system_ids: ["s1"] }),
      task("b2", "Внести код процесса", { bpmn_scope: "o1", role_id: "r2" }),
      { id: "b9", type: "event", subtype: "end", name: "Реестр актуализирован", bpmn_scope: "o1", role_id: "r2" },
    ],
    flows: [
      { id: "bf1", from: "b0", to: "b1" },
      { id: "bf2", from: "b1", to: "b2" },
      { id: "bf3", from: "b2", to: "b9" },
    ],
    assignments: [
      { node_id: null, role_id: "r1", kind: "owner", functions: ["Отвечает за результат процесса"] },
      { node_id: "s1", role_id: "r1", kind: "owner" },
      { node_id: "s2", role_id: "r1", kind: "owner" },
      { node_id: "o1", role_id: "r3", kind: "controller" },
      { node_id: "o1", role_id: "r2", kind: "executor", functions: ["Внесение данных в реестр"] },
    ],
  });
}