/**
 * Значки типов задач BPMN в левом верхнем углу блока (как на диаграммах Business Studio): человек у пользовательской,
 * шестерёнка у сервисной, конверт у отправки и получения, рука у ручной, лист у сценария, таблица у бизнес-правила.
 * Контуры в квадрате 16 × 16, общие для редактора в браузере и выгрузки VSDX (рисуются тонкой линией, без заливки).
 */
export type IconPart = { kind: "path"; pts: [number, number][]; closed?: boolean } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

/** Сторона квадрата значка. */
export const TASK_ICON_SIZE = 16;
/** Отступ значка от левого верхнего угла блока. */
export const TASK_ICON_PAD = 5;

const gear = (): IconPart[] => {
  const teeth: IconPart[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    teeth.push({ kind: "path", pts: [[8 + 4.6 * Math.cos(a), 8 + 4.6 * Math.sin(a)], [8 + 6.8 * Math.cos(a), 8 + 6.8 * Math.sin(a)]] });
  }
  return [{ kind: "ellipse", cx: 8, cy: 8, rx: 4.6, ry: 4.6 }, { kind: "ellipse", cx: 8, cy: 8, rx: 2, ry: 2 }, ...teeth];
};

const ICONS: Record<string, () => IconPart[]> = {
  user: () => [
    { kind: "ellipse", cx: 8, cy: 5, rx: 2.5, ry: 2.5 },
    { kind: "path", pts: [[2.8, 14.5], [3.4, 11.4], [5.4, 9.6], [8, 9], [10.6, 9.6], [12.6, 11.4], [13.2, 14.5]] },
  ],
  service: gear,
  send: () => [
    { kind: "path", pts: [[1.5, 3.5], [14.5, 3.5], [14.5, 12.5], [1.5, 12.5]], closed: true },
    { kind: "path", pts: [[1.5, 3.5], [8, 9], [14.5, 3.5]] },
  ],
  receive: () => [
    { kind: "path", pts: [[1.5, 3.5], [14.5, 3.5], [14.5, 12.5], [1.5, 12.5]], closed: true },
    { kind: "path", pts: [[1.5, 3.5], [8, 9], [14.5, 3.5]] },
  ],
  manual: () => [
    { kind: "path", pts: [[3, 12.5], [3, 6.5], [4.8, 6.5], [4.8, 9], [6, 9], [6, 3], [7.8, 3], [7.8, 8], [9, 8], [9, 3.8], [10.8, 3.8], [10.8, 8], [12, 8], [12, 6], [14, 6], [14, 11.5], [11, 14], [6, 14]], closed: true },
  ],
  script: () => [
    { kind: "path", pts: [[3.5, 1.5], [12.5, 1.5], [12.5, 14.5], [3.5, 14.5]], closed: true },
    { kind: "path", pts: [[5.5, 5], [10.5, 5]] },
    { kind: "path", pts: [[5.5, 8], [10.5, 8]] },
    { kind: "path", pts: [[5.5, 11], [9, 11]] },
  ],
  business_rule: () => [
    { kind: "path", pts: [[1.5, 3], [14.5, 3], [14.5, 13], [1.5, 13]], closed: true },
    { kind: "path", pts: [[1.5, 6.3], [14.5, 6.3]] },
    { kind: "path", pts: [[1.5, 9.7], [14.5, 9.7]] },
    { kind: "path", pts: [[6.3, 6.3], [6.3, 13]] },
  ],
};

/** Контуры значка типа задачи (квадрат 16 × 16); у обычной задачи значка нет. */
export function taskIcon(subtype: string | null | undefined): IconPart[] {
  const make = subtype ? ICONS[subtype] : undefined;
  return make ? make() : [];
}
