import { describe, expect, it } from "vitest";
import { buildModelFromParsedBpmn, parseBpmnXml } from "../src/pipeline/diagramImport.js";

/** F2: дорожки BPMN — это исполнители; flowNodeRef связывает шаг с ролью, служебная дорожка ролью не становится. */
describe("импорт BPMN: исполнители из дорожек", () => {
  it("шаг получает роль своей дорожки, «Без исполнителя» остаётся служебной", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P1">
    <laneSet id="LS1">
      <bpmn:lane id="L1" name="Роль 2"><bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef></bpmn:lane>
      <lane id="L2" name="Без исполнителя"><flowNodeRef>Task_2</flowNodeRef></lane>
    </laneSet>
    <task id="Task_1" name="Отклонить заявку" />
    <task id="Task_2" name="Проверить заявку" />
    <sequenceFlow id="F1" sourceRef="Task_1" targetRef="Task_2" />
  </process>
</definitions>`;
    const parsed = parseBpmnXml(xml);
    expect(parsed.lanes.find((l) => l.id === "L1")?.refs).toEqual(["Task_1"]);
    const { model } = buildModelFromParsedBpmn(parsed, { processName: "Проверка", modelType: "AS-IS" } as never);
    expect(model.roles.map((r) => r.name)).toEqual(["Роль 2"]);
    const task1 = model.nodes.find((n) => n.name === "Отклонить заявку")!;
    const task2 = model.nodes.find((n) => n.name === "Проверить заявку")!;
    expect(task1.role_id).toBe(model.roles[0].id);
    expect(task2.role_id).toBeNull();
  });
});
