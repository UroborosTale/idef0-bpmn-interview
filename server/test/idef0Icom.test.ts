import { describe, expect, it } from "vitest";
import { b002Model } from "../src/reference/b002.js";
import { labelSpec, layoutIdef0 } from "../src/shared/idef0Layout.js";

/**
 * В9 (план BS6): ICOM-коды на концах стрелок — I (вход), C (управление), O (выход), M (механизм).
 * Номер даётся сущности в её классе один раз: у «разбитой» стрелки код одинаков на всех отрезках.
 */
describe("ICOM-коды стрелок IDEF0", () => {
  const cls = (kind: string) => (kind === "input" || kind === "link" ? "I" : kind === "output" ? "O" : kind === "role" || kind === "system" ? "M" : "C");

  it("каждая стрелка получает код своего класса и место у блока", () => {
    const lay = layoutIdef0(b002Model(), null);
    expect(lay.arrows.length).toBeGreaterThan(4);
    for (const a of lay.arrows) {
      expect(a.code, a.key).toMatch(new RegExp(`^${cls(a.kind)}\\d+$`));
      expect(a.codeAt, a.key).toBeTruthy();
      expect(["start", "end"]).toContain(a.codeAnchor);
    }
  });

  it("в SVG ICOM-коды выводятся только при включённой настройке модели (I6)", async () => {
    const { generateIdef0 } = await import("../src/pipeline/idef0.js");
    const plain = generateIdef0(b002Model()).decompositionSvg;
    expect(plain).not.toMatch(/>[ICOM]\d+</);
    const coded = generateIdef0({ ...b002Model(), show_icom: true }).decompositionSvg;
    expect(coded).toMatch(/>[ICOM]\d+</);
  });

  it("номер — на сущность в классе: у разбитой стрелки код один на всех отрезках", () => {
    const lay = layoutIdef0(b002Model(), null);
    const codes = new Map<string, Set<string>>();
    for (const a of lay.arrows) {
      const key = `${cls(a.kind)}:${a.entityId}`;
      (codes.get(key) ?? codes.set(key, new Set()).get(key)!).add(a.code!);
    }
    for (const [key, set] of codes) expect(set.size, key).toBe(1);
  });

  it("нумерация в классе идёт с 1 без пропусков", () => {
    const lay = layoutIdef0(b002Model(), null);
    for (const c of ["I", "C", "O", "M"]) {
      const nums = [...new Set(lay.arrows.filter((a) => cls(a.kind) === c).map((a) => Number(a.code!.slice(1))))].sort((x, y) => x - y);
      if (nums.length) expect(nums, c).toEqual(nums.map((_, i) => i + 1));
    }
  });

  it("код не налезает на длинную подпись: у подписи на линии он вынесен выше", () => {
    const lay = layoutIdef0(b002Model(), null);
    for (const a of lay.arrows) {
      const sp = labelSpec(a as never);
      if (!sp || !a.codeAt || (a.side !== "left" && a.side !== "right" && a.side !== "mid")) continue;
      const lines = sp.text.split("\n").length;
      const labelTop = sp.y - 10;
      // подпись стоит на линии/над ней; код поднят выше её верхней строки
      expect(a.codeAt[1] + 2, a.key).toBeLessThanOrEqual(labelTop);
      expect(lines, a.key).toBeGreaterThan(0);
    }
  });
});
