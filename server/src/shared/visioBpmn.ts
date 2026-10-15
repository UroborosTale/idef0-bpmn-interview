import type { TriggerType } from "./events.js";

/**
 * Свойства BPMN в фигурах Visio (трафарет «BPMN», ячейки раздела Property с префиксом Bpmn). Тип задачи, шлюза, события и
 * потока хранится там строкой из списка Format, а не в имени мастера: у всех задач мастер один — «Задача».
 * Список локализован (в русском Visio — русские названия, у значения по умолчанию в кэше остаётся английский токен),
 * поэтому значения читаются по названиям на обоих языках; неизвестное значение не ошибка, а предупреждение.
 * Модуль общий для импорта (pipeline/vsdxImport.ts) и экспорта VSDX.
 */

export interface VisioProp {
  /** Значение; у экземпляра фигуры может не быть — тогда действует значение мастера. */
  value?: string;
  /** Список допустимых значений (ячейка Format), если есть. */
  format?: string;
}
export type VisioProps = Record<string, VisioProp>;

export type VisioKind = "task" | "subprocess" | "gateway" | "event" | "flow" | "pool" | "ignore";
export type VisioTaskType = "user" | "service" | "manual" | "send" | "receive" | "script" | "business_rule";
export type VisioLoop = "standard" | "parallel" | "sequential";
export type VisioGateway = "exclusive" | "parallel" | "inclusive" | "event_based" | "complex" | "event_based_start" | "parallel_event_based";
export type VisioEventPosition = "start" | "intermediate" | "end";
export type VisioFlowType = "sequence" | "message" | "association";

export interface VisioBpmnInfo {
  /** Вид фигуры по свойствам; не задан, если свойств BPMN у фигуры нет или по ним вид не определить. */
  kind?: VisioKind;
  taskType?: VisioTaskType;
  loop?: VisioLoop;
  gateway?: VisioGateway;
  position?: VisioEventPosition;
  /** «Промежуточное (без прерывания)»: у граничного события — не прерывает задачу. */
  nonInterrupting?: boolean;
  /** «Промежуточное (генерация)»: событие выбрасывает, а не ждёт. */
  throwing?: boolean;
  trigger?: TriggerType;
  flowType?: VisioFlowType;
  /** Условие ветки: «Выражение» — условная, «По умолчанию» — ветка по умолчанию. */
  condition?: "expression" | "default";
  /** Что в фигуре есть, а в модели пока нет, и что в списке не опознано: тексты для предупреждения импорта. */
  lost: string[];
}

/** Имена ячеек, по которым фигура считается фигурой трафарета BPMN. */
export const BPMN_PROP_PREFIX = "Bpmn";

export const hasBpmnProps = (props: VisioProps): boolean => Object.keys(props).some((k) => k.startsWith(BPMN_PROP_PREFIX));

/** Значение без кавычек, лишних пробелов, регистра и «ё»; пустое и служебное «нет» — пустая строка. */
export function normValue(v: string | undefined): string {
  return (v ?? "").replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ").trim().toLowerCase().replace(/ё/g, "е");
}

const isNone = (n: string) => n === "" || n === "none" || n === "нет" || n === "no";

const val = (props: VisioProps, name: string): string => normValue(props[name]?.value);

// --- задача ---

function taskTypeOf(n: string, lost: string[]): VisioTaskType | undefined {
  if (isNone(n)) return undefined;
  if (/бизнес.?правил|business.?rule/.test(n)) return "business_rule";
  if (/служб|сервис|service/.test(n)) return "service";
  if (/получ|прием|receive/.test(n)) return "receive"; // в том числе «Создание экземпляра приема»
  if (/отправ|send/.test(n)) return "send";
  if (/пользоват|user/.test(n)) return "user";
  if (/сценар|script/.test(n)) return "script";
  if (/вручн|руковод|manual/.test(n)) return "manual";
  lost.push(`тип задачи «${n}»`);
  return undefined;
}

function loopOf(n: string, lost: string[]): VisioLoop | undefined {
  if (isNone(n)) return undefined;
  if (/последовательн|sequential/.test(n)) return "sequential";
  if (/параллельн|parallel/.test(n)) return "parallel";
  if (/стандарт|standard|loop|цикл/.test(n)) return "standard";
  lost.push(`цикличность «${n}»`);
  return undefined;
}

// --- шлюз ---

function gatewayOf(n: string, exclusiveType: string, lost: string[]): VisioGateway {
  if (/сложн|complex|комплексн/.test(n)) return "complex";
  if (/параллельн.*событ|parallel.*event/.test(n)) return "parallel_event_based";
  if (/исключающ.*событ|exclusive.*event/.test(n)) return /создани|запуск|new instance|start/.test(n) ? "event_based_start" : "event_based";
  if (/включающ|inclusive/.test(n)) return "inclusive";
  if (/^(оператор )?и$|parallel|параллельн/.test(n)) return "parallel";
  if (/исключающ|exclusive/.test(n)) return /событ|event/.test(exclusiveType) ? "event_based" : "exclusive";
  lost.push(`тип шлюза «${n}» (прочитан как исключающий)`);
  return "exclusive";
}

// --- событие ---

const TRIGGERS: [RegExp, TriggerType][] = [
  [/parallel multiple|составн\w* параллельн|параллельн\w* составн/, "parallel_multiple"],
  [/multiple|составн/, "multiple"],
  [/message|сообщени/, "message"],
  [/timer|таймер/, "timer"],
  [/error|ошибк/, "error"],
  [/cancel|отмен/, "cancel"],
  [/compensation|компенсац/, "compensation"],
  [/conditional|услов/, "conditional"],
  [/link|ссылк/, "link"],
  [/signal|сигнал/, "signal"],
  [/terminate|останов|завершен/, "terminate"],
  [/escalation|эскалац/, "escalation"],
];

export function triggerOf(n: string): TriggerType | undefined {
  if (isNone(n)) return undefined;
  return TRIGGERS.find(([re]) => re.test(n))?.[1];
}

function positionOf(n: string): { position?: VisioEventPosition; nonInterrupting: boolean; throwing: boolean } {
  const nonInterrupting = /без прерыван|non.?interrupt/.test(n);
  const throwing = /генерац|throw/.test(n);
  if (/промежуточн|intermediate/.test(n)) return { position: "intermediate", nonInterrupting, throwing };
  if (/начальн|start/.test(n)) return { position: "start", nonInterrupting, throwing };
  if (/завершающ|конечн|\bend\b/.test(n)) return { position: "end", nonInterrupting, throwing };
  return { nonInterrupting, throwing };
}

// --- поток ---

function flowTypeOf(n: string): VisioFlowType | undefined {
  if (/сообщени|message/.test(n)) return "message";
  if (/ассоциац|association/.test(n)) return "association";
  if (/управлен|sequence|control/.test(n)) return "sequence";
  return undefined;
}

/**
 * Разбор свойств BPMN одной фигуры Visio. У экземпляра на странице хранятся только изменённые ячейки, остальное
 * наследуется от мастера, поэтому на вход подают свойства мастера, поверх них — свойства экземпляра, а каждое свойство
 * читается независимо от остальных. Вид определяется по тому, какие свойства есть: у шлюза — BpmnGatewayType, у события —
 * BpmnEventType, у потока — BpmnConnectingObjectType, у задачи и подпроцесса — BpmnActivityType. Значение «по умолчанию»
 * (английский токен None) читается как «ничего не задано».
 */
export function decodeVisioBpmn(props: VisioProps): VisioBpmnInfo {
  const lost: string[] = [];
  const out: VisioBpmnInfo = { lost };
  if (!hasBpmnProps(props)) return out;

  if (props.BpmnTaskType) out.taskType = taskTypeOf(val(props, "BpmnTaskType"), lost);
  if (props.BpmnLoopType) out.loop = loopOf(val(props, "BpmnLoopType"), lost);
  if (props.BpmnGatewayType) out.gateway = gatewayOf(val(props, "BpmnGatewayType"), val(props, "BpmnExclusiveType"), lost);
  if (props.BpmnEventType) Object.assign(out, positionOf(val(props, "BpmnEventType")));
  const trigger = triggerOf(val(props, "BpmnTriggerOrResult")) ?? triggerOf(val(props, "BpmnEventDetailType"));
  if (trigger) out.trigger = trigger;
  if (props.BpmnConnectingObjectType) {
    out.flowType = flowTypeOf(val(props, "BpmnConnectingObjectType")) ?? "sequence";
    const c = val(props, "BpmnConditionType");
    if (/выражен|expression/.test(c)) out.condition = "expression";
    else if (/по умолчанию|^default$/.test(c)) out.condition = "default";
  }

  if (props.BpmnGatewayType) out.kind = "gateway";
  else if (props.BpmnEventType) out.kind = "event";
  else if (props.BpmnConnectingObjectType) out.kind = "flow";
  else if (props.BpmnPoolName || props.BpmnPoolElementType) out.kind = "pool";
  else if (props.BpmnActivityType) out.kind = /подпроцесс|sub.?process|call/.test(val(props, "BpmnActivityType")) ? "subprocess" : "task";
  // BpmnElementType: артефакты (примечание, группа, данные) в шаги не превращаются
  else if (/артефакт|artifact/.test(val(props, "BpmnElementType"))) out.kind = "ignore";
  return out;
}

// --- запись: модель → свойства Visio ---

/** Свойство для записи в раздел Property фигуры: значение выбирается из списка (Type = 1, «фиксированный список»). */
export interface VisioPropOut {
  name: string;
  label: string;
  value: string;
  list: string[];
}

const TASK_LABELS: Record<string, string> = { none: "Нет", service: "Служба", receive: "Получить", send: "Отправить", user: "Пользователь", script: "Сценарий", manual: "Вручную", business_rule: "Бизнес-правило" };
const TASK_LIST = ["Нет", "Служба", "Получить", "Отправить", "Пользователь", "Сценарий", "Вручную", "Создание экземпляра приема", "Бизнес-правило"];
const ACTIVITY_LIST = ["Задача", "Подпроцесс"];
const GATEWAY_LIST = ["Оператор исключающего ИЛИ", "Исключающее событие(создание нового экземпляра)", "Оператор включающего ИЛИ", "Оператор И", "Параллельное событие(создание нового экземпляра)", "Сложный оператор"];
const GATEWAY_LABELS: Record<string, string> = { exclusive: GATEWAY_LIST[0], event_based: GATEWAY_LIST[0], event_based_start: GATEWAY_LIST[1], inclusive: GATEWAY_LIST[2], parallel: GATEWAY_LIST[3], parallel_event_based: GATEWAY_LIST[4], complex: GATEWAY_LIST[5] };
const EXCLUSIVE_LIST = ["Данные", "Событие"];
const EVENT_LIST = ["Начальное событие", "Начальное (без прерывания)", "Промежуточное событие", "Промежуточное (без прерывания)", "Промежуточное (генерация)", "Завершающее событие"];
// как в трафарете Visio, список триггеров — английские токены даже в русской версии
const TRIGGER_LIST = ["None", "Message", "Timer", "Error", "Cancel", "Compensation", "Conditional", "Link", "Signal", "Multiple", "Escalation", "Parallel Multiple", "Terminate"];
const TRIGGER_TOKEN: Record<TriggerType, string> = {
  none: "None",
  message: "Message",
  timer: "Timer",
  error: "Error",
  cancel: "Cancel",
  compensation: "Compensation",
  conditional: "Conditional",
  link: "Link",
  signal: "Signal",
  multiple: "Multiple",
  escalation: "Escalation",
  parallel_multiple: "Parallel Multiple",
  terminate: "Terminate",
};
const CONNECTING_LIST = ["Поток управления", "Поток сообщений", "Ассоциация"];
const CONDITION_LIST = ["Нет", "Выражение", "По умолчанию"];
const LOOP_LIST = ["Нет", "Стандартная", "Параллельная составная", "Последовательная составная"];
const LOOP_INDEX: Record<string, number> = { standard: 1, parallel: 2, sequential: 3 };

const prop = (name: string, label: string, value: string, list: string[]): VisioPropOut => ({ name, label, value, list });

export interface ShapeForVisio {
  kind: "task" | "subprocess" | "gateway" | "event";
  subtype?: string;
  event?: { position: "start" | "intermediate" | "boundary" | "end"; trigger: TriggerType; throwing: boolean };
  interrupting?: boolean;
  loop?: VisioLoop;
}

/** Свойства BPMN фигуры шага, шлюза или события: те же имена и значения, что в трафарете «BPMN» Visio. */
export function visioShapeProps(s: ShapeForVisio): VisioPropOut[] {
  if (s.kind === "task" || s.kind === "subprocess") {
    return [
      prop("BpmnActivityType", "Вид действия", ACTIVITY_LIST[s.kind === "task" ? 0 : 1], ACTIVITY_LIST),
      prop("BpmnTaskType", "Тип задачи", TASK_LABELS[s.subtype ?? "none"] ?? TASK_LABELS.none, TASK_LIST),
      prop("BpmnLoopType", "Цикличность", LOOP_LIST[LOOP_INDEX[s.loop ?? ""] ?? 0], LOOP_LIST),
    ];
  }
  if (s.kind === "gateway") {
    const sub = s.subtype ?? "exclusive";
    return [
      prop("BpmnGatewayType", "Тип шлюза", GATEWAY_LABELS[sub] ?? GATEWAY_LIST[0], GATEWAY_LIST),
      prop("BpmnExclusiveType", "Основание выбора", EXCLUSIVE_LIST[sub === "event_based" ? 1 : 0], EXCLUSIVE_LIST),
    ];
  }
  const ev = s.event ?? { position: "intermediate" as const, trigger: "none" as TriggerType, throwing: false };
  const type =
    ev.position === "start" ? EVENT_LIST[0] : ev.position === "end" ? EVENT_LIST[5] : ev.position === "boundary" ? (s.interrupting === false ? EVENT_LIST[3] : EVENT_LIST[2]) : ev.throwing ? EVENT_LIST[4] : EVENT_LIST[2];
  return [prop("BpmnEventType", "Вид события", type, EVENT_LIST), prop("BpmnTriggerOrResult", "Триггер или результат", TRIGGER_TOKEN[ev.trigger] ?? "None", TRIGGER_LIST)];
}

/** Свойства BPMN стрелки: поток управления; подпись — условие ветки, «по умолчанию» — ветка без условия. */
export function visioFlowProps(hasCondition: boolean, isDefault = false): VisioPropOut[] {
  return [prop("BpmnConnectingObjectType", "Тип связи", CONNECTING_LIST[0], CONNECTING_LIST), prop("BpmnConditionType", "Условие", CONDITION_LIST[isDefault ? 2 : hasCondition ? 1 : 0], CONDITION_LIST)];
}
