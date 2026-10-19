import { describe, expect, it } from "vitest";
import { structuredModel } from "../../test/fixtures";
import { addNote, deleteNote, findNote, moveNote, noteLines, notesOf, resizeNote, updateNote } from "./notes";

/**
 * В12: свободные текстовые блоки диаграммы IDEF0 — хранение в модели по диаграмме (ключ "" — верхняя,
 * иначе id функции) и правка по id с любой диаграммы (панель не знает, где блок лежит).
 */
describe("свободные текстовые блоки IDEF0", () => {
  it("создание: блок ложится на текущую диаграмму с положением и размером", () => {
    const m = structuredModel();
    const r = addNote(m, null, 100, 200, "Допущение");
    expect(r.id).toBe("note1");
    expect(notesOf(r.model, null)).toEqual([{ id: "note1", text: "Допущение", x: 100, y: 200, w: 180, h: 60 }]);
    expect(notesOf(r.model, "o1")).toEqual([]);
    // второй блок — на диаграмме функции, первый остаётся на верхней
    const r2 = addNote(r.model, "o1", 10, 20);
    expect(notesOf(r2.model, "o1")).toHaveLength(1);
    expect(notesOf(r2.model, null)).toHaveLength(1);
    expect(r2.id).toBe("note2");
  });

  it("правка и удаление — по id, где бы блок ни лежал", () => {
    const m = addNote(structuredModel(), "o1", 0, 0, "Старый текст").model;
    const id = notesOf(m, "o1")[0].id;
    const moved = updateNote(m, id, { text: "Новый текст", x: 50, y: 60 });
    expect(findNote(moved, id)).toMatchObject({ text: "Новый текст", x: 50, y: 60 });
    const deleted = deleteNote(moved, id);
    expect(findNote(deleted, id)).toBeUndefined();
    expect(moved.idef0_notes).toBeDefined();
    expect(deleted.idef0_notes).toBeUndefined(); // последний блок убирает поле из модели
  });

  it("текст переносится по ширине блока", () => {
    const lines = noteLines("Допущение: сроки уточняются после согласования заявки", 180);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toContain("Допущение");
  });

  it("перетаскивание не уводит блок за край листа, размер не меньше минимума", () => {
    const m = addNote(structuredModel(), null, 100, 100, "Допущение").model;
    const id = notesOf(m, null)[0].id;
    expect(findNote(moveNote(m, id, -40, 55.4), id)).toMatchObject({ x: 0, y: 55, w: 180, h: 60 });
    // растягивание: угол вправо-вниз добавляет размер, но не меньше NOTE_MIN
    expect(findNote(resizeNote(m, id, 260, 120), id)).toMatchObject({ w: 260, h: 120, x: 100, y: 100 });
    expect(findNote(resizeNote(m, id, 20, 10), id)).toMatchObject({ w: 100, h: 40 });
    // чужой id ничего не меняет
    expect(moveNote(m, "нет-такого", 0, 0)).toBe(m);
  });
});
