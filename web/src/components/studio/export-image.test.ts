import { describe, expect, it } from "vitest";
import { diagramSvg } from "./export-image";

function canvas() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "bpe-svg");
  svg.innerHTML = `<defs><marker id="arrow"/></defs><g transform="translate(300 200) scale(0.5)"><rect x="10" y="10" width="100" height="50"/><text>Шаг</text><g data-connect="a"><circle r="9"/></g></g>`;
  return svg;
}

describe("выгрузка диаграммы с экрана", () => {
  it("самостоятельный SVG: размер по содержимому, белый фон, без «ручек», без сдвига и масштаба экрана", () => {
    const out = diagramSvg(canvas(), { x: 10, y: 10, width: 400, height: 200 })!;
    expect(out.width).toBe(448);
    expect(out.height).toBe(248);
    const doc = new DOMParser().parseFromString(out.svg, "image/svg+xml");
    const svg = doc.documentElement;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(out.svg.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)).toHaveLength(1); // сериализатор сам объявляет пространство имён, без дублей
    expect(svg.getAttribute("viewBox")).toBe("0 0 448 248");
    expect(svg.getAttribute("class")).toBeNull();
    expect(doc.querySelector("[data-connect]")).toBeNull();
    expect(doc.querySelector("g[transform]")!.getAttribute("transform")).toBe("translate(14 14)");
    expect(doc.querySelector("defs marker#arrow")).toBeTruthy(); // стрелки не теряют наконечники
    const children = [...svg.children].map((c) => c.tagName);
    expect(children.indexOf("rect")).toBeLessThan(children.indexOf("g")); // фон под диаграммой
    expect(doc.querySelector("text")!.textContent).toBe("Шаг");
  });

  it("исходный холст не меняется", () => {
    const c = canvas();
    diagramSvg(c, { x: 0, y: 0, width: 10, height: 10 });
    expect(c.querySelector("g[transform]")!.getAttribute("transform")).toBe("translate(300 200) scale(0.5)");
    expect(c.querySelector("[data-connect]")).toBeTruthy();
  });

  it("пустая диаграмма — выгружать нечего", () => {
    expect(diagramSvg(canvas(), { x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    const bare = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    expect(diagramSvg(bare)).toBeNull();
  });
});