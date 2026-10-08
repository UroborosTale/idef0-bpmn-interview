import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";
import ChatPanel from "./ChatPanel";

const msg = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", role: "assistant", text: "Расскажите о процессе", ts: 1, ...extra });

describe("чат интервью: свой вопрос интервьюера", () => {
  const setup = (chat: ChatMessage[] = [msg()], extra: { finished?: boolean; onAsk?: (t: string) => Promise<void> } = {}) => {
    const onSend = vi.fn(async () => {});
    const onAsk = extra.onAsk ?? vi.fn(async () => {});
    render(<ChatPanel chat={chat} busy={false} finished={extra.finished ?? false} onSend={onSend} onFinish={vi.fn()} onAsk={onAsk} />);
    return { onSend, onAsk };
  };
  const field = () => document.querySelector("textarea") as HTMLTextAreaElement;

  it("обычный ввод — ответ владельца; «Свой вопрос» переключает поле на вопрос, после отправки возвращает ответ", async () => {
    const { onSend, onAsk } = setup();
    fireEvent.change(field(), { target: { value: "Закупки ведёт отдел снабжения" } });
    fireEvent.click(screen.getByText("Отправить"));
    expect(onSend).toHaveBeenCalledWith("Закупки ведёт отдел снабжения");
    expect(onAsk).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Свой вопрос"));
    expect(field().placeholder).toMatch(/Ваш вопрос владельцу/);
    expect((screen.getByText("Задать вопрос") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "  Кто заменяет директора?  " } });
    fireEvent.click(screen.getByText("Задать вопрос"));
    expect(onAsk).toHaveBeenCalledWith("Кто заменяет директора?");
    expect(onSend).toHaveBeenCalledTimes(1);
    await screen.findByText("Отправить"); // режим вернулся к ответу владельца
    expect(field().placeholder).toMatch(/Ответьте на вопрос/);
  });

  it("Enter отправляет вопрос в режиме вопроса; короткий текст не уходит", () => {
    const { onSend, onAsk } = setup();
    fireEvent.click(screen.getByText("Свой вопрос"));
    fireEvent.change(field(), { target: { value: "Да?" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "Какие системы используются?" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onAsk).toHaveBeenCalledWith("Какие системы используются?");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("вопрос интервьюера в ленте подписан; после завершения интервью ввода нет", () => {
    const { onAsk } = setup([msg(), msg({ id: "m2", text: "Кто согласует?", author: "ivanov" }), msg({ id: "m3", text: "Системный вопрос" })]);
    expect(screen.getByText("Вопрос интервьюера (ivanov)")).toBeTruthy();
    expect(document.querySelectorAll(".by-interviewer")).toHaveLength(1);
    expect(onAsk).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    setup([msg()], { finished: true });
    expect(screen.queryByText("Свой вопрос")).toBeNull();
  });

  it("логин local (вход отключён) в подписи не показывается", () => {
    setup([msg({ author: "local", text: "Вопрос без входа" })]);
    expect(screen.getByText("Вопрос интервьюера")).toBeTruthy();
  });
});