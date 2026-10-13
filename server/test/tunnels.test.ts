import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { generateIdef0 } from "../src/pipeline/idef0.js";
import { validateModel } from "../src/pipeline/validate.js";
import { layoutIdef0, tunnelArcs } from "../src/shared/idef0Layout.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { structuredModel } from "./fixtures.js";

const unbalanced = (m: ProcessLogicModel, parent = "s1") => validateModel(m).filter((i) => i.rule === "idef0_unbalanced" && i.element_id === parent);

describe("туннели стрелок IDEF0", () => {
  it("исходная декомпозиция сбалансирована", () => {
    expect(unbalanced(structuredModel())).toEqual([]);
  });

  it("лишний вход у дочерней функции — предупреждение; туннель у свободного конца (up) его снимает", () => {
    const m = structuredModel();
    const o1 = m.nodes.find((n) => n.id === "o1")!;
    o1.inputs.push("d4");
    expect(unbalanced(m)).toHaveLength(1);
    expect(unbalanced(m)[0].message).toContain("есть у дочерних функций, но нет у родителя");
    o1.tunnels = { "input:d4": { up: true } };
    expect(unbalanced(m)).toEqual([]);
    // туннель не того конца не помогает
    o1.tunnels = { "input:d4": { down: true } };
    expect(unbalanced(m)).toHaveLength(1);
  });

  it("лишний выход у родителя — предупреждение; туннель у блока (down) его снимает", () => {
    const m = structuredModel();
    const s1 = m.nodes.find((n) => n.id === "s1")!;
    s1.outputs.push("d4");
    expect(unbalanced(m)).toHaveLength(1);
    expect(unbalanced(m)[0].message).toContain("есть у родителя, но нет у дочерних функций");
    s1.tunnels = { "output:d4": { down: true } };
    expect(unbalanced(m)).toEqual([]);
  });

  it("туннель снимает только свою стрелку, остальное по-прежнему считается", () => {
    const m = structuredModel();
    const o1 = m.nodes.find((n) => n.id === "o1")!;
    m.data.push({ id: "dx", name: "Лишний документ", kind: "document", source: [] } as never);
    o1.inputs.push("d4", "dx");
    o1.tunnels = { "input:d4": { up: true } };
    const [w] = unbalanced(m);
    expect(w.message).toContain("Лишний документ"); // dx остался
    expect(w.message).not.toContain(m.data.find((d) => d.id === "d4")!.name);
  });

  it("раскладка помечает стрелки: скобки у свободного конца и у блока, только у внешних видов", () => {
    const m = structuredModel();
    const o1 = m.nodes.find((n) => n.id === "o1")!;
    o1.tunnels = { "input:d1": { up: true }, "output:d2": { down: true }, "control:c1": { up: true, down: true } };
    const arrows = layoutIdef0(m, "s1").arrows.filter((a) => a.nodeId === "o1");
    const flag = (kind: string) => arrows.find((a) => a.kind === kind);
    expect(flag("input")).toMatchObject({ tunnelUp: true });
    expect(flag("input")!.tunnelDown).toBeUndefined();
    expect(flag("control")).toMatchObject({ tunnelUp: true, tunnelDown: true });
    // выход d2 идёт к o2 связью-link: внутренняя стрелка, скобок не получает
    expect(arrows.filter((a) => a.kind === "link" || a.kind === "controlLink").every((a) => !a.tunnelUp && !a.tunnelDown)).toBe(true);
    const link = layoutIdef0(m, "s1").arrows.find((a) => a.key.startsWith("link:o2:d2"));
    expect(link?.tunnelDown).toBeUndefined();
  });

  it("схема модели принимает туннели; без поля их нет", () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "o1")!.tunnels = { "input:d1": { up: true } };
    expect(ProcessLogicModel.safeParse(JSON.parse(JSON.stringify(m))).success).toBe(true);
    expect(structuredModel().nodes[0].tunnels).toBeUndefined();
  });
});

describe("туннели: скобки на дуги и в выгрузках", () => {
  it("дуги: две на каждый помеченный конец, у свободного и у блока в разных местах; у внутренних видов нет", () => {
    const a = layoutIdef0(structuredModel(), "s1").arrows.find((x) => x.key === "input:o1:d1")!;
    expect(tunnelArcs(a)).toEqual([]);
    const one = tunnelArcs({ ...a, tunnelUp: true });
    const both = tunnelArcs({ ...a, tunnelUp: true, tunnelDown: true });
    expect(one).toHaveLength(2);
    expect(both).toHaveLength(4);
    // свободный конец входа — начало ломаной (слева), блок — конец (справа)
    expect(Math.max(...one.map((x) => x.from[0]))).toBeLessThan(a.points[0][0] + 20);
    expect(Math.min(...both.slice(2).map((x) => x.from[0]))).toBeGreaterThan(a.points[0][0] + 20);
    expect(tunnelArcs({ ...a, kind: "link", tunnelUp: true })).toEqual([]);
  });

  const withTunnel = () => {
    const m = structuredModel();
    m.nodes.find((n) => n.id === "o1")!.tunnels = { "input:d1": { up: true }, "control:c1": { down: true } };
    return m;
  };

  it("SVG диаграммы IDEF0 содержит скобки только у помеченных стрелок", () => {
    const plain = generateIdef0(structuredModel()).children.find((c) => c.parentNodeId === "s1")!.svg;
    const svg = generateIdef0(withTunnel()).children.find((c) => c.parentNodeId === "s1")!.svg;
    const arcs = (s: string) => (s.match(/ Q[\d.\-]+,[\d.\-]+ /g) ?? []).length;
    expect(arcs(plain)).toBe(0);
    expect(arcs(svg)).toBe(4); // два конца, по две скобки
  });

  it("VSDX: скобки рисуются ломаными-оформлением и не ломают чтение правок", async () => {
    const count = async (m: ProcessLogicModel) => {
      const zip = await JSZip.loadAsync(await buildVsdx(m));
      const xml = (await Promise.all(Object.keys(zip.files).filter((n) => /^visio\/pages\/page\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")))).join(" ");
      return (xml.match(/<Shape /g) ?? []).length;
    };
    expect(await count(withTunnel())).toBe((await count(structuredModel())) + 4);
  });
});

