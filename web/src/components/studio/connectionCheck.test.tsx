import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { session, structuredModel } from "../../test/fixtures";
import Studio from "./Studio";
import { ConnectionCheckDialog } from "./ObjectDialogs";

/**
 * В10: «Проверка соединения» — окно со списком проблемных концов стрелок и кнопка в ленте IDEF0.
 * Сами правила проверяются на сервере (`server/test/connectionCheck.test.ts`).
 */
describe("проверка соединения IDEF0", () => {
  it("окно показывает замечания и «замечаний нет»", () => {
    const issue = { id: "dup:f1:inputs:d1", kind: "dup" as const, nodeId: "f1", message: "Функция 1: «Заявка» указан в разделе «Входы» дважды." };
    const { unmount } = render(<ConnectionCheckDialog issues={[issue]} onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog", { name: "Проверка соединения" });
    expect(dialog.textContent).toContain("«Заявка» указан в разделе «Входы» дважды");
    expect(dialog.textContent).toContain("Замечаний: 1");
    unmount();
    render(<ConnectionCheckDialog issues={[]} onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "Проверка соединения" }).textContent).toContain("Проблемных концов не найдено");
  });

  it("кнопка ленты открывает окно для текущей диаграммы", () => {
    render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(document.querySelector('[data-nav-fn="o1"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Проверка соединения" }));
    expect(screen.getByRole("dialog", { name: "Проверка соединения" })).toBeTruthy();
  });
});
