import { describe, expect, it } from "vitest";
import { structuredModel } from "../../test/fixtures";
import { applyStructure, outlineFromModel, parseOutline } from "./structure-ops";

/**
 * Мастер структуры открывается с текущей структурой из модели (outlineFromModel), поэтому применение того же
 * списка повторно не должно ничего удваивать: существующие функции находятся по имени и родителю и не создаются заново.
 */
describe("мастер структуры: применение — это дельта, а не добавление всего списка", () => {
  it("повторное применение той же структуры не добавляет ни одной функции", () => {
    const m = structuredModel();
    const { items } = parseOutline(outlineFromModel(m));
    const once = applyStructure(m, items);
    expect(once.nodes.length).toBe(m.nodes.length);

    const again = applyStructure(once, parseOutline(outlineFromModel(once)).items);
    expect(again.nodes.length).toBe(once.nodes.length);
    // и содержимое не поменялось: те же id
    expect(again.nodes.map((n) => n.id).sort()).toEqual(once.nodes.map((n) => n.id).sort());
  });

  it("добавляется только новая строка, существующие остаются на месте", () => {
    const m = structuredModel();
    const text = `${outlineFromModel(m)}\n    Новая операция`;
    const next = applyStructure(m, parseOutline(text).items);
    expect(next.nodes.length).toBe(m.nodes.length + 1);
    const added = next.nodes.filter((n) => n.name === "Новая операция");
    expect(added).toHaveLength(1);
    // новая операция попала под последний подпроцесс (отступ в четыре пробела), а не в корень
    expect(added[0].idef0_parent).not.toBeNull();
    expect(m.nodes.some((n) => n.name === "Новая операция")).toBe(false);
  });
});
