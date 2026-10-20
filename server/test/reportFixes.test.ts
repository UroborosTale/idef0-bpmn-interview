import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import { applyAnsweredGaps } from "../src/pipeline/gaps.js";
import { emptyModel } from "../src/types/model.js";

delete process.env.AUTH_USERS;

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const BPMN = `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d1"><bpmn:process id="p1" isExecutable="false"><bpmn:startEvent id="s" name="Начало" /><bpmn:task id="t" name="Проверить заявку" /><bpmn:endEvent id="e" name="Конец" /><bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t" /><bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e" /></bpmn:process></bpmn:definitions>`;
const meta = { processName: "Проверка заявки", modelType: "AS-IS" };

describe("ответ на пробел", () => {
  it("помечает пробел отвеченным и переживает пересборку модели (A4)", () => {
    const model = emptyModel({ id: "p", name: "Процесс" });
    model.gaps = [
      { id: "gap1", rule: "missing_executor", priority: "critical", element_id: "n1", question: "Кто выполняет действие «Проверить заявку»?", status: "open", asked_count: 0 },
      { id: "gap2", rule: "missing_next", priority: "important", element_id: "n1", question: "Что происходит после «Проверить заявку»?", status: "open", asked_count: 0 },
    ];
    const n = applyAnsweredGaps(model, [{ question: "Кто выполняет действие «Проверить заявку»?", answerText: "Охранник" }]);
    expect(n).toBe(1);
    expect(model.gaps[0]).toMatchObject({ status: "answered", answer: "Охранник" });
    expect(model.gaps[1].status).toBe("open");
    // повторное применение ничего не портит
    expect(applyAnsweredGaps(model, [{ question: "Кто выполняет действие «Проверить заявку»?", answerText: "Охранник" }])).toBe(0);
  });
});

describe("импорт диаграмм: формат и режим сессии", () => {
  it("файл не того формата — понятный отказ, сессия не создаётся", async () => {
    const before = (await app.call("GET", "/sessions")).body.length;
    const r = await app.call("POST", "/diagram-import/new", { format: "bpmn", content: "<mxfile><mxGraphModel/></mxfile>", meta });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/не похож на BPMN/);
    const after = (await app.call("GET", "/sessions")).body.length;
    expect(after).toBe(before);
  });

  it("импортированная сессия — «рисование с нуля», а не обработка текста", async () => {
    const r = await app.call("POST", "/diagram-import/new", { format: "bpmn", content: BPMN, meta });
    expect(r.status).toBe(201);
    expect(r.body.session.mode).toBe("blank");
    expect(r.body.session.model.nodes.length).toBeGreaterThan(0);
  });
});

describe("выгрузки читают текущую модель, а не устаревший кэш", () => {
  it("после правки модели без пересборки .bpmn и .svg содержат новое название", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta })).body;
    const model = s.model;
    model.process.name = "Проверка заявки (новое)";
    expect((await app.call("PUT_BASE", `/sessions/${s.id}/model|${s.updatedAt}`, model)).status).toBe(200);
    // кэш диаграмм остался прежним (diagramsStale), но выгрузка обязана собрать свежие
    const bpmn = await app.call("GET", `/sessions/${s.id}/export/bpmn`);
    expect(bpmn.status).toBe(200);
    expect(String(bpmn.body)).toContain("Проверка заявки (новое)");
    const svg = await app.call("GET", `/sessions/${s.id}/export/idef0/context.svg`);
    expect(svg.status).toBe(200);
    expect(String(svg.body)).toContain("Проверка заявки (новое)");
    // после выгрузки кэш снова актуален
    const after = (await app.call("GET", `/sessions/${s.id}`)).body;
    expect(after.diagramsStale).toBe(false);
  });
});
