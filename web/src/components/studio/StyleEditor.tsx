import { useEffect, useRef, useState } from "react";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, STYLE_KIND_LABELS, hasOwnStyle, styleOf, type ShapeStyle, type StyleKind } from "@shared/shapeStyles";
import type { ProcessLogicModel } from "../../types";
import { Field } from "../editor-core/fields";
import { Section } from "./PanelParts";
import { resetKindStyle, setKindStyle } from "./style-ops";

type M = ProcessLogicModel;

/**
 * Оформление вида фигуры: заливка, линия, цвет и размер текста. Относится ко всем фигурам этого вида на всех диаграммах —
 * так «применить стиль выбранной фигуры ко всем» делается одним действием: изменили у выбранной, изменилось у всех.
 * Цвет меняется непрерывно, пока тянут ползунок выбора, поэтому в историю он попадает после паузы или потери фокуса.
 */
export default function StyleEditor({ model, kind, onChange }: { model: M; kind: StyleKind; onChange: (next: M) => void }) {
  const style = styleOf(model, kind);
  const [draft, setDraft] = useState<ShapeStyle>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const pending = useRef<ShapeStyle>({});
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    setDraft({});
    pending.current = {};
  }, [kind]);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    setDraft({});
    if (Object.keys(patch).length) onChange(setKindStyle(modelRef.current, kind, patch));
  };
  const change = (patch: ShapeStyle) => {
    pending.current = { ...pending.current, ...patch };
    setDraft((d) => ({ ...d, ...patch }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  const shown = { ...style, ...draft };
  const color = (key: "fill" | "line" | "text", label: string) => (
    <Field label={label}>
      <input type="color" value={shown[key]} onChange={(e) => change({ [key]: e.target.value })} onBlur={flush} />
    </Field>
  );

  return (
    <Section title="Оформление" open={hasOwnStyle(model, kind)}>
      <p className="muted prop-note">Относится ко всем фигурам вида «{STYLE_KIND_LABELS[kind]}» на всех диаграммах.</p>
      {color("fill", "Заливка")}
      {color("line", "Линия")}
      {color("text", "Цвет текста")}
      <Field label="Размер текста">
        <select value={shown.font_size} onChange={(e) => change({ font_size: Number(e.target.value) })} onBlur={flush}>
          {Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => FONT_SIZE_MIN + i).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <button
        disabled={!hasOwnStyle(model, kind)}
        onClick={() => {
          if (timer.current) clearTimeout(timer.current);
          pending.current = {};
          setDraft({});
          onChange(resetKindStyle(model, kind));
        }}
      >
        Сбросить к стандартному
      </button>
    </Section>
  );
}
