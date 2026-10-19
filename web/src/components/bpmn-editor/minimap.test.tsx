import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MiniMap from "./MiniMap";

/**
 * Миникарта висит в правом нижнем углу холста — там же, где штамп листа: на 100 % она закрывала его правый край.
 * Если штамп попал в это место, карта поднимается над ним (замечание с осмотра веб-версии).
 */
const base = {
  nodes: [],
  world: { w: 1000, h: 500 },
  view: { k: 1, tx: 0, ty: 0 },
  size: { w: 800, h: 400 },
  onCenter: () => undefined,
};

describe("миникарта и штамп листа", () => {
  it("без штампа стоит в углу по CSS", () => {
    const { container } = render(<MiniMap {...base} />);
    expect((container.querySelector("[data-minimap]") as HTMLElement).style.bottom).toBe("");
  });

  it("штамп листа не закрывается: карта поднимается над ним", () => {
    const { container } = render(<MiniMap {...base} stamp={{ x: 700, y: 340, w: 180, h: 46 }} />);
    const bottom = parseInt((container.querySelector("[data-minimap]") as HTMLElement).style.bottom, 10);
    expect(bottom).toBeGreaterThan(28);
  });

  it("штамп в стороне от угла положение не меняет", () => {
    const { container } = render(<MiniMap {...base} stamp={{ x: 40, y: 40, w: 180, h: 46 }} />);
    expect((container.querySelector("[data-minimap]") as HTMLElement).style.bottom).toBe("");
  });
});
