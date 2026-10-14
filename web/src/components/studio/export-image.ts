/**
 * Выгрузка диаграммы, нарисованной в редакторе, — ровно в том виде, как она на экране сейчас
 * (в отличие от выгрузок с сервера, которые строятся по сохранённой версии).
 */

const PAD = 24;

/** Самостоятельный SVG из холста редактора: без выделения и «ручек», с белым фоном, по размеру содержимого. */
export function diagramSvg(canvas: SVGSVGElement, bbox?: { x: number; y: number; width: number; height: number }): { svg: string; width: number; height: number } | null {
  const world = canvas.querySelector<SVGGElement>(":scope > g[transform]");
  if (!world) return null;
  const box = bbox ?? world.getBBox();
  if (!box.width || !box.height) return null;
  const width = Math.ceil(box.width + PAD * 2);
  const height = Math.ceil(box.height + PAD * 2);

  const clone = canvas.cloneNode(true) as SVGSVGElement;
  const g = clone.querySelector<SVGGElement>(":scope > g[transform]")!;
  g.setAttribute("transform", `translate(${PAD - box.x} ${PAD - box.y})`);
  clone.querySelectorAll("[data-connect]").forEach((el) => el.remove()); // «ручка» протягивания стрелки
  clone.querySelectorAll("[data-frame-resize]").forEach((el) => el.remove()); // ручки размера листа
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const bg = clone.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, g); // под диаграммой, после <defs>
  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}

/** Лист, включённый на диаграмме (белая подложка рамки), — в координатах диаграммы; без листа — null. */
export function sheetBox(canvas: SVGSVGElement): { x: number; y: number; width: number; height: number } | null {
  const back = canvas.querySelector<SVGRectElement>("[data-frame-back] > rect");
  if (!back) return null;
  return { x: Number(back.getAttribute("x")), y: Number(back.getAttribute("y")), width: Number(back.getAttribute("width")), height: Number(back.getAttribute("height")) };
}

/** SVG → PNG через canvas браузера (масштаб 2× для чёткости). */
export function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width * 2;
      c.height = height * 2;
      const ctx = c.getContext("2d")!;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("не удалось получить PNG"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("не удалось нарисовать диаграмму"));
    };
    img.src = url;
  });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]+/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
