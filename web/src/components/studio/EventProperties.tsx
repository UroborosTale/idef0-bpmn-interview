import { POSITION_LABELS, TIMER_HINTS, TIMER_LABELS, TRIGGER_HAS_NAME, TRIGGER_LABELS, TRIGGER_NAME_LABEL, allowedTriggers, eventSpec, triggerGaps, triggerProblem, type EventTrigger, type TimerKind, type TriggerType } from "@shared/events";
import type { ProcessLogicModel, ProcessNode } from "../../types";
import { CommitInput, Field } from "../editor-core/fields";
import { setEventDirection, setEventPosition, setEventTrigger } from "../bpmn-editor/model-ops";
import { Section } from "./PanelParts";

type M = ProcessLogicModel;

/** Из каких триггеров можно собрать событие «несколько»: простые, допустимые для граничного/промежуточного/начального события. */
const MEMBER_CHOICES: TriggerType[] = ["message", "timer", "conditional", "signal", "error", "escalation", "compensation", "cancel", "link"];

/**
 * Карточка события: вид (начальное, промежуточное, конечное; граничное — если прикреплено к задаче), направление
 * промежуточного (ждёт или выбрасывает), триггер и его параметры — срок таймера, условие, название сообщения, сигнала,
 * ошибки, ссылки. Допустимые триггеры зависят от вида по BPMN 2.0.
 */
export default function EventProperties({ model, node, boundary, onChange }: { model: M; node: ProcessNode; boundary: boolean; onChange: (next: M) => void }) {
  const spec = eventSpec(node, boundary);
  const problem = triggerProblem(spec);
  const gaps = node.trigger ? triggerGaps(spec) : [];
  const options = allowedTriggers(spec.position, spec.throwing);
  const trigger: EventTrigger = { ...spec.details, type: spec.trigger };
  const setTrigger = (patch: Partial<EventTrigger>) => onChange(setEventTrigger(model, node.id, { ...trigger, ...patch }));
  const members = trigger.members ?? [];
  const allowedMembers = MEMBER_CHOICES.filter((t) => allowedTriggers(spec.position, spec.throwing).includes(t));

  return (
    <Section title="Событие и триггер" open>
      {boundary ? (
        <Field label="Вид события">
          <input value={POSITION_LABELS.boundary} readOnly title="Чтобы изменить вид, открепите событие от задачи (блок «Граничное событие» ниже)" />
        </Field>
      ) : (
        <Field label="Вид события">
          <select value={spec.position} onChange={(e) => onChange(setEventPosition(model, node.id, e.target.value as "start" | "intermediate" | "end"))}>
            <option value="start">{POSITION_LABELS.start} (запускает процесс)</option>
            <option value="intermediate">{POSITION_LABELS.intermediate} (посреди процесса)</option>
            <option value="end">{POSITION_LABELS.end} (завершает ветку)</option>
          </select>
        </Field>
      )}
      {spec.position === "intermediate" && (
        <Field label="Направление">
          <select value={spec.throwing ? "throw" : "catch"} onChange={(e) => onChange(setEventDirection(model, node.id, e.target.value as "catch" | "throw"))}>
            <option value="catch">Ждёт, получает (значок не залит)</option>
            <option value="throw">Выбрасывает, отправляет (значок залит)</option>
          </select>
        </Field>
      )}
      <Field label="Триггер">
        <select
          value={spec.trigger}
          onChange={(e) => {
            const type = e.target.value as TriggerType;
            onChange(setEventTrigger(model, node.id, type === "none" ? null : { type, direction: spec.position === "intermediate" ? (spec.throwing ? "throw" : "catch") : undefined }));
          }}
        >
          {!options.includes(spec.trigger) && <option value={spec.trigger}>{TRIGGER_LABELS[spec.trigger]} (не подходит этому виду)</option>}
          {options.map((t) => (
            <option key={t} value={t}>
              {TRIGGER_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>

      {spec.trigger === "timer" && (
        <>
          <Field label="Когда срабатывает">
            <select value={trigger.timer?.kind ?? "duration"} onChange={(e) => setTrigger({ timer: { kind: e.target.value as TimerKind, value: trigger.timer?.value ?? "" } })}>
              {(Object.keys(TIMER_LABELS) as TimerKind[]).map((k) => (
                <option key={k} value={k}>
                  {TIMER_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Значение таймера">
            <CommitInput value={trigger.timer?.value ?? ""} placeholder={TIMER_HINTS[trigger.timer?.kind ?? "duration"]} onCommit={(v) => setTrigger({ timer: { kind: trigger.timer?.kind ?? "duration", value: v.trim() } })} />
          </Field>
        </>
      )}
      {spec.trigger === "conditional" && (
        <Field label="Условие">
          <CommitInput multiline rows={2} value={trigger.condition ?? ""} placeholder="например: остаток на складе меньше 10" onCommit={(v) => setTrigger({ condition: v.trim() })} />
        </Field>
      )}
      {TRIGGER_HAS_NAME.has(spec.trigger) && (
        <Field label={TRIGGER_NAME_LABEL[spec.trigger] ?? "Название"}>
          <CommitInput value={trigger.name ?? ""} onCommit={(v) => setTrigger({ name: v.trim() || null })} />
        </Field>
      )}
      {(spec.trigger === "multiple" || spec.trigger === "parallel_multiple") && (
        <Field label="Из каких триггеров состоит">
          <div className="prop-checks">
            {allowedMembers.map((t) => (
              <label key={t} className="prop-check">
                <input type="checkbox" checked={members.includes(t)} onChange={(e) => setTrigger({ members: e.target.checked ? [...members, t] : members.filter((x) => x !== t) })} /> {TRIGGER_LABELS[t]}
              </label>
            ))}
          </div>
        </Field>
      )}

      {problem && <p className="prop-warn">Событие не соответствует BPMN: {problem}.</p>}
      {gaps.map((g) => (
        <p key={g} className="prop-warn">
          Заполните: {g}.
        </p>
      ))}
      <p className="muted prop-note">
        {spec.position === "start" && "Начальное событие только ждёт: что именно запускает процесс — сообщение, срок, условие, сигнал."}
        {spec.position === "intermediate" && (spec.throwing ? "Выбрасывающее событие что-то отправляет и идёт дальше (значок залит)." : "Ждущее событие останавливает поток, пока не наступит триггер (значок не залит).")}
        {spec.position === "boundary" && "Граничное событие ждёт триггер, пока выполняется задача, и начинает отдельную ветку."}
        {spec.position === "end" && "Конечное событие завершает ветку; его триггер — результат: сообщение, ошибка, сигнал, завершение всего процесса."}
      </p>
    </Section>
  );
}
