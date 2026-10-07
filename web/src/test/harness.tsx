import { useState, type ReactElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import type { ProcessLogicModel } from "../types";

type M = ProcessLogicModel;

/** Рендер компонента, который правит модель через onChange: модель живёт в состоянии, последняя доступна через model(). */
export function renderWithModel(initial: M, ui: (m: M, onChange: (next: M) => void) => ReactElement) {
  const ref = { current: initial, changes: 0 };
  function Host() {
    const [m, set] = useState(initial);
    return ui(m, (next) => {
      ref.current = next;
      ref.changes++;
      set(next);
    });
  }
  const r = render(<Host />);
  return { ...r, model: () => ref.current, changes: () => ref.changes };
}

/** Поле панели по подписи (подпись в разметке не связана с полем — см. отчёт). */
export function field(label: string, root: ParentNode = document.body): HTMLInputElement {
  const box = [...root.querySelectorAll(".bpe-field")].find((f) => f.querySelector(":scope > label")?.textContent === label);
  const el = box?.querySelector("input, textarea, select");
  if (!el) throw new Error(`Поле «${label}» не найдено`);
  return el as HTMLInputElement;
}

/** Ввод в поле с фиксацией по потере фокуса (как в CommitInput). */
export function commit(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}
