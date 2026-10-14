import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ProcessLogicModel } from "../types";

type M = ProcessLogicModel;

/**
 * Строка навигатора по началу текста (или точному совпадению). Если она на другой вертикальной вкладке панели
 * («Деятельность», «Справочники», «Отчёты»), вкладка открывается.
 */
/** Вертикальная вкладка навигатора по названию («Деятельность», «Справочники», «Отчёты»). */
export const navTab = (title: string) => fireEvent.click(screen.getByRole("tab", { name: title }));

export function navRow(text: string, exact = false): HTMLElement {
  const find = () => [...document.querySelectorAll<HTMLElement>(".nav-row")].find((n) => (exact ? n.textContent?.trim() === text : n.textContent?.trim().startsWith(text)));
  let row = find();
  for (const tab of document.querySelectorAll(".nav-vtab")) {
    if (row) break;
    fireEvent.click(tab);
    row = find();
  }
  if (!row) throw new Error(`В навигаторе нет строки «${text}»`);
  return row;
}

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

/** Поле панели по подписи — через связь подписи с полем, как это делает экранный диктор. */
export function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}
/** Ввод в поле с фиксацией по потере фокуса (как в CommitInput). */
export function commit(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}
