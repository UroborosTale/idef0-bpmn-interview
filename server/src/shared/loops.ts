/**
 * Цикличность задачи или подпроцесса BPMN (маркер на фигуре): стандартный цикл или несколько экземпляров — параллельно либо
 * последовательно. Общий модуль генератора BPMN, VSDX и редактора в браузере (web подключает его через псевдоним @shared).
 * Ветка «по умолчанию» (is_default у потока) отдельного типа не требует: в XML это атрибут default у узла-источника.
 */

export const LOOP_KINDS = ["standard", "parallel", "sequential"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

export const LOOP_LABELS: Record<LoopKind, string> = {
  standard: "Цикл (повторять)",
  parallel: "Несколько экземпляров параллельно",
  sequential: "Несколько экземпляров по очереди",
};

/** Характеристика цикличности внутри элемента задачи или подпроцесса в BPMN 2.0 XML (после ассоциаций данных). */
export function loopXml(loop: LoopKind | null | undefined): string {
  if (loop === "standard") return "<bpmn:standardLoopCharacteristics />";
  if (loop === "parallel") return '<bpmn:multiInstanceLoopCharacteristics isSequential="false" />';
  if (loop === "sequential") return '<bpmn:multiInstanceLoopCharacteristics isSequential="true" />';
  return "";
}

/**
 * Узлы, у которых в BPMN может быть ветка по умолчанию (атрибут default): задачи, подпроцессы и шлюзы,
 * выбирающие по условию (исключающий, включающий).
 */
export const canHaveDefaultFlow = (n: { type: string; subtype?: string | null }): boolean =>
  n.type === "task" || n.type === "subprocess" || (n.type === "gateway" && (!n.subtype || n.subtype === "exclusive" || n.subtype === "inclusive"));
