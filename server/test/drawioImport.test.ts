import { describe, expect, it } from "vitest";
import {
  buildModelFromParsedDrawio,
  drawioEndEventHint,
  drawioGatewaySubtype,
  drawioShapeKind,
  drawioTaskSubtype,
  parseDrawioXml,
} from "../src/pipeline/diagramImport.js";

/**
 * A5 из отчёта 19.10: раньше любая вершина draw.io становилась задачей. Теперь вид фигуры берётся из стиля,
 * дорожка — из swimlane, а подпись ребра — из edgeLabel.
 */
const meta = { processName: "Закупка", modelType: "AS-IS" } as never;

const cell = (id: string, attrs: string) => `<mxCell id="${id}" ${attrs}><mxGeometry x="0" y="0" width="120" height="60" as="geometry" /></mxCell>`;
const edge = (id: string, source: string, target: string, value = "", extra = "") =>
  `<mxCell id="${id}" ${value ? `value="${value}" ` : ""}style="edgeStyle=orthogonalEdgeStyle;html=1;${extra}" edge="1" parent="lane" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry" /></mxCell>`;

function diagram(cells: string): string {
  return `<mxfile><diagram id="d" name="Page-1"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells}</root></mxGraphModel></diagram></mxfile>`;
}

const laneCell = `<mxCell id="lane" value="Отдел закупок" style="swimlane;html=1;startSize=20;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="800" height="200" as="geometry" /></mxCell>`;

describe("импорт draw.io: вид фигуры по стилю (A5)", () => {
  it("стили BPMN 2.0 и базовые фигуры", () => {
    expect(drawioShapeKind("swimlane;html=1;")).toBe("lane");
    expect(drawioShapeKind("ellipse;whiteSpace=wrap;html=1;")).toBe("event");
    expect(drawioShapeKind("rhombus;whiteSpace=wrap;html=1;")).toBe("gateway");
    expect(drawioShapeKind("shape=mxgraph.bpmn.event;outline=standard;symbol=general;")).toBe("event");
    expect(drawioShapeKind("shape=mxgraph.bpmn.gateway2;gwType=parallel;")).toBe("gateway");
    expect(drawioShapeKind("shape=mxgraph.bpmn.task2;taskMarker=service;")).toBe("task");
    expect(drawioShapeKind("shape=mxgraph.bpmn.task2;isSubProcess=1;")).toBe("subprocess");
    expect(drawioShapeKind("shape=mxgraph.bpmn.data;")).toBe("skip");
    expect(drawioShapeKind("text;html=1;")).toBe("skip");
    expect(drawioShapeKind("edgeLabel;html=1;")).toBe("skip");
  });

  it("подтипы шлюза, задачи и конечного события", () => {
    expect(drawioGatewaySubtype("shape=mxgraph.bpmn.gateway2;gwType=parallel;")).toBe("parallel");
    expect(drawioGatewaySubtype("shape=mxgraph.bpmn.gateway2;gwType=eventBased;")).toBe("event_based");
    expect(drawioGatewaySubtype("rhombus;")).toBe("exclusive");
    expect(drawioTaskSubtype("shape=mxgraph.bpmn.task2;taskMarker=user;")).toBe("user");
    expect(drawioTaskSubtype("shape=mxgraph.bpmn.task2;taskMarker=businessRule;")).toBe("business_rule");
    expect(drawioTaskSubtype("rounded=1;")).toBeUndefined();
    expect(drawioEndEventHint("shape=mxgraph.bpmn.event;outline=end;symbol=general;")).toBe(true);
    expect(drawioEndEventHint("shape=mxgraph.bpmn.event;outline=standard;symbol=general;")).toBe(false);
  });

  it("сценарий из отчёта: круг — событие, ромб — шлюз, swimlane — исполнитель, подписи — условия", () => {
    const xml = diagram(
      laneCell +
        cell("s", 'value="Заявка получена" style="ellipse;whiteSpace=wrap;html=1;aspect=fixed;" vertex="1" parent="lane"') +
        cell("t", 'value="Проверить заявку" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="lane"') +
        cell("g", 'value="Заявка полная?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="lane"') +
        cell("e", 'value="Заявка согласована" style="ellipse;whiteSpace=wrap;html=1;strokeWidth=3;" vertex="1" parent="lane"') +
        edge("f1", "s", "t") +
        edge("f2", "t", "g") +
        edge("f3", "g", "e", "да") +
        edge("f4", "g", "t", "нет")
    );
    const parsed = parseDrawioXml(xml);
    const { model } = buildModelFromParsedDrawio(parsed, meta);
    const byName = new Map(model.nodes.map((n) => [n.name, n]));

    expect(byName.get("Заявка получена")).toMatchObject({ type: "event", subtype: "start" });
    expect(byName.get("Заявка согласована")).toMatchObject({ type: "event", subtype: "end" });
    expect(byName.get("Заявка полная?")).toMatchObject({ type: "gateway", subtype: "exclusive" });
    expect(byName.get("Проверить заявку")).toMatchObject({ type: "task" });

    const role = model.roles.find((r) => r.name === "Отдел закупок");
    expect(role).toBeTruthy();
    expect(model.nodes.every((n) => n.role_id === role!.id)).toBe(true);

    const conditions = model.flows.map((f) => f.condition).filter(Boolean);
    expect(conditions).toEqual(expect.arrayContaining(["да", "нет"]));
  });

  it("подпись ветки в отдельной ячейке edgeLabel и ветка по умолчанию", () => {
    const xml = diagram(
      laneCell +
        cell("g", 'value="Есть бюджет?" style="shape=mxgraph.bpmn.gateway2;gwType=exclusive;" vertex="1" parent="lane"') +
        cell("a", 'value="Согласовать" style="shape=mxgraph.bpmn.task2;taskMarker=user;" vertex="1" parent="lane"') +
        cell("b", 'value="Отклонить" style="shape=mxgraph.bpmn.task2;taskMarker=user;" vertex="1" parent="lane"') +
        edge("f1", "g", "a") +
        edge("f2", "g", "b") +
        cell("l1", 'value="да" style="edgeLabel;html=1;" vertex="1" parent="f1"') +
        cell("l2", 'value="по умолчанию" style="edgeLabel;html=1;" vertex="1" parent="f2"')
    );
    const { model } = buildModelFromParsedDrawio(parseDrawioXml(xml), meta);
    const yes = model.flows.find((f) => f.condition === "да");
    const fallback = model.flows.find((f) => f.is_default);
    expect(yes).toBeTruthy();
    expect(fallback).toBeTruthy();
    expect(fallback!.condition).toBeNull();
  });

  it("дорожка внутри пула: роль — название дорожки, объект данных пропущен", () => {
    const xml = diagram(
      `<mxCell id="pool" value="Компания" style="swimlane;html=1;startSize=20;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="800" height="400" as="geometry" /></mxCell>` +
        `<mxCell id="lane" value="Специалист" style="swimlane;html=1;startSize=20;" vertex="1" parent="pool"><mxGeometry x="20" y="0" width="780" height="200" as="geometry" /></mxCell>` +
        cell("t", 'value="Оформить заявку" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="lane"') +
        cell("d", 'value="Заявка" style="shape=mxgraph.bpmn.data;size=15;" vertex="1" parent="lane"')
    );
    const { model, warnings } = buildModelFromParsedDrawio(parseDrawioXml(xml), meta);
    expect(model.nodes).toHaveLength(1);
    expect(model.roles.map((r) => r.name)).toEqual(["Компания", "Специалист"]);
    expect(model.nodes[0].role_id).toBe(model.roles.find((r) => r.name === "Специалист")!.id);
    expect(warnings.some((w) => /Пропущено фигур/.test(w))).toBe(true);
  });
});
