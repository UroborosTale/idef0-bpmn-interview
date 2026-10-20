import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ValidationPanel from "./ValidationPanel";
import type { ValidationIssue } from "../types";

const warning: ValidationIssue = {
  id: "v1",
  notation: "BPMN",
  severity: "warning",
  rule: "bpmn_flow_condition",
  message: "Условие не задано",
  element_id: "a",
};

/**
 * A11 из отчёта 19.10: вкладка «Валидация» показывала принятое замечание как действующее, без отметки «принято».
 */
describe("вкладка «Валидация»", () => {
  it("действующих нет — принятое показано отдельно, с причиной", () => {
    render(
      <ValidationPanel
        issues={[]}
        accepted={[{ ...warning, reason: "Так и задумано", at: "2026-10-19T10:00:00.000Z" }]}
        onSelectElement={vi.fn()}
      />
    );
    expect(screen.getByText(/Действующих замечаний нет/)).toBeTruthy();
    expect(screen.getByText("Принятые — 1")).toBeTruthy();
    expect(screen.getByText(/принято: Так и задумано/)).toBeTruthy();
  });

  it("действующие замечания идут в своих разделах, принятые — в своём", () => {
    const onSelect = vi.fn();
    render(
      <ValidationPanel
        issues={[{ ...warning, id: "v2", message: "Поток обрывается" }]}
        accepted={[{ ...warning, reason: "Ручной режим", at: null }]}
        onSelectElement={onSelect}
      />
    );
    expect(screen.getByText("Предупреждения — 1")).toBeTruthy();
    expect(screen.getByText("Принятые — 1")).toBeTruthy();
    fireEvent.click(screen.getByText(/Поток обрывается/));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("пусто — валидация пройдена", () => {
    render(<ValidationPanel issues={[]} onSelectElement={vi.fn()} />);
    expect(screen.getByText("Замечаний нет — валидация пройдена.")).toBeTruthy();
  });
});
