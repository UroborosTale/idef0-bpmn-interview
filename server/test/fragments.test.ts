import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fragmentText } from "../src/pipeline/fragment.js";

/**
 * B2 из отчёта 19.10: каждая строка Markdown становилась отдельным фрагментом вместе с `#`, `##` и `**…**`,
 * заголовки разделов попадали в интервью, а все реплики приписывались владельцу процесса.
 */
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hiring");

describe("фрагменты интервью (B2)", () => {
  it("Markdown: заголовки не реплики, разметка снята, переносы склеены, пункты — отдельно", () => {
    const text = [
      "# Интервью",
      "",
      "## Этап 1. Инициация",
      "",
      "**Владелец процесса:** Инициатор создаёт заявку,",
      "проверяет её полноту.",
      "- Руководитель подразделения — согласует заявку.",
      "- HR-менеджер — оформляет документы.",
    ].join("\n");
    const f = fragmentText(text);
    expect(f.map((x) => x.text)).toEqual([
      "Инициатор создаёт заявку, проверяет её полноту.",
      "согласует заявку.",
      "оформляет документы.",
    ]);
    expect(f.some((x) => /[#*]/.test(x.text))).toBe(false);
    expect(f[1]).toMatchObject({ speaker: "participant", speaker_label: "Руководитель подразделения" });
  });

  it("диалог без пустых строк сохраняет реплики и спикеров", () => {
    const text = "Аналитик: Как начинается процесс?\nВладелец: Менеджер получает заявку.\nАналитик: Что дальше?\nВладелец: Юрист проверяет договор.";
    const f = fragmentText(text);
    expect(f).toHaveLength(4);
    expect(f.map((x) => x.speaker)).toEqual(["interviewer", "owner", "interviewer", "owner"]);
    expect(f[1].text).toBe("Менеджер получает заявку.");
  });

  it("hiring.md: без Markdown-мусора и заголовков, пункты-роли — участники", () => {
    const raw = fs.readFileSync(path.join(fixtureDir, "hiring.md"), "utf-8");
    const f = fragmentText(raw);
    const lines = raw.split("\n").filter((l) => l.trim()).length;
    expect(f.length).toBeLessThan(lines);
    expect(f.some((x) => x.text.startsWith("#") || x.text.includes("**"))).toBe(false);
    expect(f.some((x) => x.speaker_label === "Руководитель подразделения")).toBe(true);
    expect(f.filter((x) => x.speaker === "owner").length).toBeGreaterThan(0);
  });
});
