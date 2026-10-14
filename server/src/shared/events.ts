/**
 * События BPMN: вид (начало, промежуточное, граничное, конец), триггер и его параметры. Общий модуль генератора BPMN,
 * проверок, VSDX и редактора в браузере (web подключает его через псевдоним @shared).
 *
 * В модели вид события — subtype узла (start | intermediate | end; граничное — любое событие с attached_to), а триггер —
 * поле trigger. Прежние данные, где в subtype лежал сам триггер (timer, message, error, signal), читаются как
 * промежуточное событие с этим триггером (eventSpec) и продолжают работать без переписывания.
 */

export const TRIGGER_TYPES = ["none", "message", "timer", "conditional", "signal", "error", "escalation", "compensation", "cancel", "link", "terminate", "multiple", "parallel_multiple"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type EventPosition = "start" | "intermediate" | "boundary" | "end";
export type TimerKind = "date" | "duration" | "cycle";

/** Триггер события: что его запускает (или что оно выбрасывает) и параметры этого. */
export interface EventTrigger {
  type: TriggerType;
  /** Только у промежуточного события: ждать (catch) или выбросить (throw). У начала всегда ждёт, у конца и граничного — по виду. */
  direction?: "catch" | "throw";
  /** Имя сообщения, сигнала, ошибки (код), эскалации или ссылки. */
  name?: string | null;
  timer?: { kind: TimerKind; value: string } | null;
  condition?: string | null;
  /** Для «несколько»: из каких триггеров состоит. */
  members?: TriggerType[];
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  none: "Без триггера",
  message: "Сообщение",
  timer: "Таймер",
  conditional: "Условие",
  signal: "Сигнал",
  error: "Ошибка",
  escalation: "Эскалация",
  compensation: "Компенсация",
  cancel: "Отмена",
  link: "Ссылка (переход)",
  terminate: "Завершение процесса",
  multiple: "Несколько (любой из)",
  parallel_multiple: "Несколько (все сразу)",
};

export const TIMER_LABELS: Record<TimerKind, string> = { date: "В дату и время", duration: "Через промежуток", cycle: "Периодически" };
export const TIMER_HINTS: Record<TimerKind, string> = { date: "2026-12-31T09:00:00", duration: "P3D — три дня, PT2H — два часа", cycle: "R/P1W — каждую неделю" };

/** Что именно называет поле «имя» у триггера (для подписей и подсказок). */
export const TRIGGER_NAME_LABEL: Partial<Record<TriggerType, string>> = {
  message: "Название сообщения",
  signal: "Название сигнала",
  error: "Код или название ошибки",
  escalation: "Код или название эскалации",
  link: "Имя ссылки (у выбросившего и принимающего одинаковое)",
};

export const POSITION_LABELS: Record<EventPosition, string> = { start: "Начальное", intermediate: "Промежуточное", boundary: "Граничное", end: "Конечное" };

/**
 * Какие триггеры допустимы по BPMN 2.0 для вида события; для промежуточного — отдельно «ждёт» и «выбрасывает».
 * Начало всегда ждёт, конец всегда выбрасывает, граничное событие всегда ждёт.
 */
export function allowedTriggers(position: EventPosition, throwing = false): TriggerType[] {
  switch (position) {
    case "start":
      return ["none", "message", "timer", "conditional", "signal", "multiple", "parallel_multiple"];
    case "boundary":
      return ["message", "timer", "conditional", "signal", "error", "escalation", "compensation", "cancel", "multiple", "parallel_multiple"];
    case "end":
      return ["none", "message", "signal", "error", "escalation", "compensation", "cancel", "terminate", "multiple"];
    default:
      return throwing ? ["none", "message", "signal", "escalation", "compensation", "link", "multiple"] : ["message", "timer", "conditional", "signal", "link", "multiple", "parallel_multiple"];
  }
}

/** Триггеры, у которых есть параметры: что вводить в карточке. */
export const TRIGGER_HAS_NAME = new Set<TriggerType>(["message", "signal", "error", "escalation", "link"]);

type EventLike = { type: string; subtype?: string | null; trigger?: EventTrigger | null };

/** Прежняя запись: subtype хранил сам триггер. error вне границы — конечное событие (ошибку можно только выбросить), signal — выбрасывается. */
const LEGACY: Record<string, { trigger: TriggerType; throwing: boolean }> = {
  timer: { trigger: "timer", throwing: false },
  message: { trigger: "message", throwing: false },
  error: { trigger: "error", throwing: true },
  signal: { trigger: "signal", throwing: true },
};

export interface EventSpec {
  position: EventPosition;
  trigger: TriggerType;
  /** Выбрасывает (заливка значка), а не ждёт. */
  throwing: boolean;
  details: EventTrigger;
}

/** Триггеры промежуточного события, которые без явного направления по умолчанию выбрасываются; остальные — ждут. */
const THROW_BY_DEFAULT = new Set<TriggerType>(["none", "signal", "escalation", "compensation"]);

/** Вид, триггер и направление события с учётом прежней записи. boundary — событие прикреплено к задаче этой диаграммы. */
export function eventSpec(n: EventLike, boundary = false): EventSpec {
  const legacy = n.subtype ? LEGACY[n.subtype] : undefined;
  const t = n.trigger ?? undefined;
  const type: TriggerType = t?.type ?? legacy?.trigger ?? "none";
  // прежнее «error» вне границы — конец процесса с ошибкой
  const position: EventPosition = boundary ? "boundary" : n.subtype === "start" ? "start" : n.subtype === "end" || (!t && n.subtype === "error") ? "end" : "intermediate";
  let throwing: boolean;
  if (position === "start" || position === "boundary") throwing = false;
  else if (position === "end") throwing = true;
  else if (t?.direction) throwing = t.direction === "throw";
  else if (t && legacy?.trigger !== type) throwing = THROW_BY_DEFAULT.has(type);
  else throwing = legacy?.throwing ?? true; // прежняя запись или обычное промежуточное событие без триггера
  return { position, trigger: type, throwing, details: { ...(t ?? {}), type } };
}
/** Допустимо ли событию такое сочетание вида, направления и триггера; иначе — понятное объяснение. */
export function triggerProblem(spec: EventSpec): string | null {
  if (spec.trigger === "none" && spec.position === "boundary") return "граничному событию нужен триггер: таймер, сообщение, ошибка…";
  if (allowedTriggers(spec.position, spec.throwing).includes(spec.trigger)) return null;
  const what = TRIGGER_LABELS[spec.trigger].toLowerCase();
  if (spec.position === "intermediate") return spec.throwing ? `промежуточное событие не может выбрасывать «${what}»` : `промежуточное событие не может ждать «${what}»`;
  return `${POSITION_LABELS[spec.position].toLowerCase()} событие не может иметь триггер «${what}»`;
}

/** Что не заполнено у триггера (для предупреждений): пустой список — всё в порядке. */
export function triggerGaps(spec: EventSpec): string[] {
  const d = spec.details;
  const gaps: string[] = [];
  if (spec.trigger === "timer" && !d.timer?.value?.trim()) gaps.push("не задано, когда срабатывает таймер");
  if (spec.trigger === "conditional" && !d.condition?.trim()) gaps.push("не записано условие");
  if (TRIGGER_HAS_NAME.has(spec.trigger) && !d.name?.trim()) gaps.push(`не указано: ${(TRIGGER_NAME_LABEL[spec.trigger] ?? "название").toLowerCase()}`);
  if ((spec.trigger === "multiple" || spec.trigger === "parallel_multiple") && (d.members ?? []).length < 2) gaps.push("не перечислены триггеры, из которых состоит событие (нужно не меньше двух)");
  return gaps;
}

/** Короткая подпись триггера для списков и подсказок: «Таймер: P3D», «Сообщение: Заявка». */
export function triggerSummary(spec: EventSpec): string {
  const d = spec.details;
  const base = TRIGGER_LABELS[spec.trigger];
  const extra = spec.trigger === "timer" ? d.timer?.value : spec.trigger === "conditional" ? d.condition : TRIGGER_HAS_NAME.has(spec.trigger) ? d.name : spec.trigger === "multiple" || spec.trigger === "parallel_multiple" ? (d.members ?? []).map((m) => TRIGGER_LABELS[m]).join(", ") : undefined;
  return extra?.trim() ? `${base}: ${extra.trim()}` : base;
}

/** Событие после смены триггера: subtype приводится к виду (прежние timer/message/error/signal → intermediate); null или «без триггера» — триггер убирается. */
export function withTrigger<T extends EventLike>(n: T, trigger: EventTrigger | null): T {
  const subtype = n.subtype && LEGACY[n.subtype] ? "intermediate" : n.subtype ?? "intermediate";
  return { ...n, subtype, trigger: trigger && trigger.type !== "none" ? trigger : null };
}
// --- значки триггеров (общие для редактора и VSDX) ---

export type GlyphPt = [number, number];
/** Примитив значка в координатах от центра события; filled — чёрная заливка (выбрасывание), light — белая линия поверх заливки. */
export type Glyph = { kind: "circle"; r: number; filled?: boolean } | { kind: "poly"; pts: GlyphPt[]; closed?: boolean; filled?: boolean; light?: boolean };

const pentagon = (r: number): GlyphPt[] => Array.from({ length: 5 }, (_, i) => [Math.cos(((-90 + i * 72) * Math.PI) / 180) * r, Math.sin(((-90 + i * 72) * Math.PI) / 180) * r] as GlyphPt);
const cross = (a: number, b: number): GlyphPt[] => [[-b, -a], [-a, -a], [-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a]];

/** Значок триггера; throwing — залитый. */
export function triggerGlyph(trigger: TriggerType, throwing: boolean): Glyph[] {
  const f = throwing;
  switch (trigger) {
    case "message":
      // как в Business Studio: конверт шире и ниже, клапан до середины
      return [
        { kind: "poly", pts: [[-9.5, -6], [9.5, -6], [9.5, 6], [-9.5, 6]], closed: true, filled: f },
        { kind: "poly", pts: [[-9.5, -6], [0, 0.5], [9.5, -6]], light: f },
      ];
    case "timer":
      // часы с двенадцатью делениями и двумя стрелками «Г», как в Business Studio
      return [
        { kind: "circle", r: 8 },
        { kind: "poly", pts: [[0, -5.2], [0, 0], [4.2, 0]] },
        { kind: "poly", pts: [[0.00, -8.00], [0.00, -6.20]] },
        { kind: "poly", pts: [[4.00, -6.93], [3.10, -5.37]] },
        { kind: "poly", pts: [[6.93, -4.00], [5.37, -3.10]] },
        { kind: "poly", pts: [[8.00, -0.00], [6.20, -0.00]] },
        { kind: "poly", pts: [[6.93, 4.00], [5.37, 3.10]] },
        { kind: "poly", pts: [[4.00, 6.93], [3.10, 5.37]] },
        { kind: "poly", pts: [[0.00, 8.00], [0.00, 6.20]] },
        { kind: "poly", pts: [[-4.00, 6.93], [-3.10, 5.37]] },
        { kind: "poly", pts: [[-6.93, 4.00], [-5.37, 3.10]] },
        { kind: "poly", pts: [[-8.00, 0.00], [-6.20, 0.00]] },
        { kind: "poly", pts: [[-6.93, -4.00], [-5.37, -3.10]] },
        { kind: "poly", pts: [[-4.00, -6.93], [-3.10, -5.37]] },
      ];
    case "conditional":
      return [
        { kind: "poly", pts: [[-6, -8], [6, -8], [6, 8], [-6, 8]], closed: true },
        { kind: "poly", pts: [[-4, -4.5], [4, -4.5]] },
        { kind: "poly", pts: [[-4, -1.5], [4, -1.5]] },
        { kind: "poly", pts: [[-4, 1.5], [4, 1.5]] },
        { kind: "poly", pts: [[-4, 4.5], [4, 4.5]] },
      ];
    case "signal":
      return [{ kind: "poly", pts: [[0, -8], [8, 6], [-8, 6]], closed: true, filled: f }];
    case "error":
      return [{ kind: "poly", pts: [[-4, 8], [-2, -1], [3, 2], [5, -8], [2, -1], [-3, -3]], closed: true, filled: f }];
    case "escalation":
      return [{ kind: "poly", pts: [[0, -9], [7, 7], [0, 2], [-7, 7]], closed: true, filled: f }];
    case "compensation":
      return [
        { kind: "poly", pts: [[-1, -6], [-9, 0], [-1, 6]], closed: true, filled: f },
        { kind: "poly", pts: [[8, -6], [0, 0], [8, 6]], closed: true, filled: f },
      ];
    case "cancel":
      return [{ kind: "poly", pts: cross(2, 8), closed: true, filled: f }];
    case "link":
      return [{ kind: "poly", pts: [[-8, -3], [1, -3], [1, -7], [9, 0], [1, 7], [1, 3], [-8, 3]], closed: true, filled: f }];
    case "terminate":
      return [{ kind: "circle", r: 9, filled: true }];
    case "multiple":
      return [{ kind: "poly", pts: pentagon(9), closed: true, filled: f }];
    case "parallel_multiple":
      return [{ kind: "poly", pts: cross(2.5, 9), closed: true }];
    default:
      return [];
  }
}

/** Значок, уменьшенный в k раз (для значка-триггера на блоке действия). */
export function scaleGlyphs(glyphs: Glyph[], k: number): Glyph[] {
  return glyphs.map((g) => (g.kind === "circle" ? { ...g, r: g.r * k } : { ...g, pts: g.pts.map(([x, y]) => [x * k, y * k] as GlyphPt) }));
}