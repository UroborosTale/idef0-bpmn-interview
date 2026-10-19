import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { showShellMenu, type ShellMenuItem } from "./desktop";

/**
 * В браузере оболочки нет, поэтому showShellMenu рисует HTML-меню само. Без этого молча не открывались
 * контекстное меню фигур, палитра существующих объектов, меню листа и масштаба.
 */
describe("HTML-фолбэк меню (браузер)", () => {
  it("показывает пункты, возвращает id выбранного и null по Escape", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);

    const items: ShellMenuItem[] = [
      { group: "Новый" },
      { id: "new-role", label: "Новый исполнитель…" },
      { id: "role-1", label: "Аналитик", checked: true },
      { id: "off", label: "Недоступно", disabled: true },
      { label: "Ещё", items: [{ id: "sub", label: "Вложенный пункт" }] },
    ];
    const picked = showShellMenu(anchor, items);

    fireEvent.click(await screen.findByText("Новый исполнитель…"));
    await expect(picked).resolves.toBe("new-role");
    expect(document.querySelector(".shell-menu-fallback")).toBeNull();

    const closed = showShellMenu(anchor, [{ id: "x", label: "Пункт X" }]);
    await screen.findByText("Пункт X");
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(closed).resolves.toBeNull();
  });

  it("вложенный список раскрывается и отдаёт id", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const picked = showShellMenu(anchor, [{ label: "Ещё", items: [{ id: "sub", label: "Вложенный пункт" }] }]);

    const sub = await screen.findByText("Вложенный пункт");
    expect(sub.closest("div")?.hidden).toBe(true);
    fireEvent.click(screen.getByText("Ещё ▸"));
    expect(sub.closest("div")?.hidden).toBe(false);
    fireEvent.click(sub);
    await expect(picked).resolves.toBe("sub");
  });

  it("отмеченный пункт показывается галочкой, а горячая клавиша — рядом", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const picked = showShellMenu(anchor, [{ id: "fit", label: "По размеру листа", kbd: "Ctrl+0", checked: true }]);
    const item = await screen.findByText("✓ По размеру листа Ctrl+0");
    fireEvent.click(item);
    await expect(picked).resolves.toBe("fit");
  });
});
