/**
 * Вид диаграмм на экране (не часть модели): слой подписей и номера. Подписи — названия событий и шлюзов под фигурами, условия
 * стрелок BPMN и подписи стрелок IDEF0; названия внутри задач и блоков остаются. Номера — код функции или шага BPMN на задаче и
 * код функции на блоке IDEF0. Настройка относится к окну студии и запоминается по сессии; PNG и SVG «как на экране» берут её же.
 */
export interface DisplayOptions {
  labels: boolean;
  bpmnNumbers: boolean;
  idef0Numbers: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = { labels: true, bpmnNumbers: false, idef0Numbers: true };

/** Прочитать запомненную настройку; повреждённое значение и недоступное хранилище дают значения по умолчанию. */
export function loadDisplay(key: string): DisplayOptions {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    const flag = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
    return { labels: flag(v?.labels, DEFAULT_DISPLAY.labels), bpmnNumbers: flag(v?.bpmnNumbers, DEFAULT_DISPLAY.bpmnNumbers), idef0Numbers: flag(v?.idef0Numbers, DEFAULT_DISPLAY.idef0Numbers) };
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function saveDisplay(key: string, d: DisplayOptions) {
  try {
    localStorage.setItem(key, JSON.stringify(d));
  } catch {
    /* без хранилища настройка просто не запоминается */
  }
}
