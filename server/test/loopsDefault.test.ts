import { describe, expect, it } from "vitest";
import { buildVsdx } from "../src/export/vsdx.js";
import { buildCamundaBpmn } from "../src/pipeline/bpmsExport.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { buildModelFromParsedBpmn, parseBpmnXml } from "../src/pipeline/diagramImport.js";
import { buildModelFromParsedVsdx, parseVsdx } from "../src/pipeline/vsdxImport.js";
import { ProcessLogicModel } from "../src/types/model.js";
import { branchingModel } from "./fixtures.js";

const meta = { processName: "Импорт", modelType: "AS-IS" as const, decompositionDepth: 2, notations: ["IDEF0", "BPMN"] as ("IDEF0" | "BPMN")[] };

/** Договор: проверка идёт циклом по каждому пункту, ветка «нет» — по умолчанию, подписание — несколько исполнителей по очереди. */
function loopModel(): ProcessLogicModel {
  const m = branchingModel();
  m.nodes.find((n) => n.id === "t1")!.loop = "standard";
  m.nodes.find((n) => n.id === "t3")!.loop = "sequential";
  m.nodes.find((n) => n.id === "t4")!.loop = "parallel";
  const f4 = m.flows.find((f) => f.id === "f4")!;
  f4.is_default = true;
  f4.condition = null;
  return m;
}

describe("цикличность задач и ветка по умолчанию", () => {
  it("модель принимает поля, неизвестная цикличность отклоняется", () => {
    expect(ProcessLogicModel.safeParse(loopModel()).success).toBe(true);
    const bad = JSON.parse(JSON.stringify(loopModel()));
    bad.nodes[1].loop = "forever";
    expect(ProcessLogicModel.safeParse(bad).success).toBe(false);
  });

  it("BPMN XML: loopCharacteristics у задач и default у шлюза-источника", async () => {
    const { xml } = await generateBpmn(loopModel());
    expect(xml).toMatch(/name="[^"]*проверить договор"[^>]*>(?:(?!<\/bpmn:\w+>)[^])*<bpmn:standardLoopCharacteristics \/>/i);
    expect(xml).toContain('<bpmn:multiInstanceLoopCharacteristics isSequential="true" />');
    expect(xml).toContain('<bpmn:multiInstanceLoopCharacteristics isSequential="false" />');
    expect(xml).toMatch(/<bpmn:exclusiveGateway id="[^"]*" name="Есть замечания\?" default="Flow_f4" \/>/);
  });

  it("default только у узла, где он допустим: у параллельного шлюза и события его нет", async () => {
    const m = loopModel();
    m.nodes.find((n) => n.id === "g")!.subtype = "parallel";
    const { xml } = await generateBpmn(m);
    expect(xml).not.toContain('default="Flow_f4"');
  });

  it("экспорт для Camunda несёт то же", () => {
    const { xml } = buildCamundaBpmn(loopModel());
    expect(xml).toContain("<bpmn:standardLoopCharacteristics />");
    expect(xml).toContain('default="Flow_f4"');
  });

  it("файл .bpmn читается обратно: цикличность и ветка по умолчанию", async () => {
    const { xml } = await generateBpmn(loopModel());
    const { model } = buildModelFromParsedBpmn(parseBpmnXml(xml), meta);
    const byName = (n: string) => model.nodes.find((x) => x.name === n)!;
    expect(byName("проверить договор").loop).toBe("standard");
    expect(byName("подписать договор").loop).toBe("sequential");
    expect(byName("уведомить клиента").loop).toBe("parallel");
    expect(byName("вернуть на доработку").loop).toBeUndefined();
    const gate = byName("Есть замечания?");
    const toSign = model.flows.find((f) => f.from === gate.id && f.to === byName("подписать договор").id)!;
    const toFix = model.flows.find((f) => f.from === gate.id && f.to === byName("вернуть на доработку").id)!;
    expect(toSign.is_default).toBe(true);
    expect(toFix.is_default).toBeUndefined();
  });

  it("подпроцесс: цикличность не путается с вложенными элементами", () => {
    const xml = `<bpmn:definitions xmlns:bpmn="x"><bpmn:process id="P">
      <bpmn:subProcess id="S1" name="Внешний"><bpmn:multiInstanceLoopCharacteristics isSequential="true" />
        <bpmn:task id="T1" name="Внутри"><bpmn:standardLoopCharacteristics /></bpmn:task></bpmn:subProcess>
      <bpmn:subProcess id="S2" name="Без цикла"><bpmn:task id="T2" name="Цикл внутри"><bpmn:standardLoopCharacteristics /></bpmn:task></bpmn:subProcess>
    </bpmn:process></bpmn:definitions>`;
    const { model } = buildModelFromParsedBpmn(parseBpmnXml(xml), meta);
    const byName = (n: string) => model.nodes.find((x) => x.name === n)!;
    expect(byName("Внешний").loop).toBe("sequential");
    expect(byName("Без цикла").loop).toBeUndefined();
    expect(byName("Внутри").loop).toBe("standard");
  });

  it("VSDX: круговой обмен возвращает цикличность и ветку по умолчанию", async () => {
    const { model } = buildModelFromParsedVsdx(await parseVsdx(await buildVsdx(loopModel())), meta);
    const byName = (n: string) => model.nodes.find((x) => x.name === n)!;
    expect(byName("проверить договор").loop).toBe("standard");
    expect(byName("подписать договор").loop).toBe("sequential");
    expect(byName("уведомить клиента").loop).toBe("parallel");
    expect(byName("вернуть на доработку").loop).toBeUndefined();
    const gate = byName("Есть замечания?");
    const defaults = model.flows.filter((f) => f.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ from: gate.id, to: byName("подписать договор").id });
  });
});
