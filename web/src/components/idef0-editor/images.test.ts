import { describe, expect, it } from "vitest";
import { structuredModel } from "../../test/fixtures";
import { addImage, deleteImage, findImage, fitImage, imagesOf, moveImage, resizeImage, updateImage } from "./images";

const png = "data:image/png;base64,iVBORw0KGgo=";

/**
 * В12: рисунки на диаграмме IDEF0 — хранение по диаграмме (ключ "" — верхняя, иначе id функции),
 * вставка с сохранением пропорций и правка по id с любой диаграммы.
 */
describe("рисунки на диаграмме IDEF0", () => {
  it("вставка: пропорции сохраняются, картинка не крупнее 480×360", () => {
    expect(fitImage(1600, 1200)).toEqual({ w: 480, h: 360 });
    expect(fitImage(200, 100)).toEqual({ w: 200, h: 100 }); // мелкую не растягиваем
    expect(fitImage(0, 0)).toEqual({ w: 40, h: 30 }); // мусорные размеры — минимум

    const m = structuredModel();
    const r = addImage(m, null, { name: "схема.png", data: png, w: 1600, h: 1200 }, 100, 50);
    expect(r.id).toBe("img1");
    expect(imagesOf(r.model, null)).toEqual([{ id: "img1", name: "схема.png", data: png, x: 100, y: 50, w: 480, h: 360 }]);
    expect(imagesOf(r.model, "o1")).toEqual([]);
    // id не повторяются между диаграммами
    expect(addImage(r.model, "o1", { name: "b.jpg", data: png, w: 10, h: 10 }, 0, 0).id).toBe("img2");
  });

  it("перенос, растягивание и удаление — по id, где бы рисунок ни лежал", () => {
    const m = addImage(structuredModel(), "o1", { name: "схема.png", data: png, w: 100, h: 100 }, 10, 20).model;
    const id = imagesOf(m, "o1")[0].id;
    expect(findImage(moveImage(m, id, -30, 44.6), id)).toMatchObject({ x: 0, y: 45, w: 100, h: 100 });
    expect(findImage(resizeImage(m, id, 200, 5), id)).toMatchObject({ w: 200, h: 30 });
    expect(findImage(updateImage(m, id, { name: "другое.png" }), id)!.name).toBe("другое.png");
    const deleted = deleteImage(m, id);
    expect(findImage(deleted, id)).toBeUndefined();
    expect(deleted.idef0_images).toBeUndefined(); // последний рисунок убирает поле из модели
    expect(deleteImage(m, "нет-такого")).toBe(m);
  });
});