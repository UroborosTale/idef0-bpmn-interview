import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ModelPanel from "./ModelPanel";
import { purchaseModel } from "../test/fixtures";

describe("вкладка «Модель»: документы и данные", () => {
  const setup = () => {
    const model = purchaseModel();
    const onUpdateModel = vi.fn();
    const { container } = render(<ModelPanel model={model} selectedId={null} onSelectElement={() => {}} onUpdateNode={() => {}} onUpdateModel={onUpdateModel} />);
    container.querySelectorAll("details").forEach((d) => (d.open = true));
    return { model, onUpdateModel };
  };

  it("название документа правится, вид меняется, новая запись добавляется", () => {
    const { model, onUpdateModel } = setup();
    const first = model.data[0];
    const input = screen.getByLabelText(`Название: ${first.name}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Новое название" } });
    fireEvent.blur(input);
    expect(onUpdateModel.mock.calls[0][0].data[0].name).toBe("Новое название");

    fireEvent.change(screen.getByLabelText(`Вид: ${first.name}`), { target: { value: first.kind === "document" ? "data" : "document" } });
    expect(onUpdateModel.mock.calls[1][0].data[0].kind).not.toBe(first.kind);

    const add = screen.getByPlaceholderText("Новый документ или данные");
    fireEvent.change(add, { target: { value: "Акт" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(onUpdateModel.mock.calls[2][0].data.at(-1).name).toBe("Акт");
  });

  it("пустое название не применяется", () => {
    const { model, onUpdateModel } = setup();
    const input = screen.getByLabelText(`Название: ${model.data[0].name}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(onUpdateModel).not.toHaveBeenCalled();
  });
});
