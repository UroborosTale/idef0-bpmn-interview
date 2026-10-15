import { describe, expect, it } from "vitest";
import { lcStatus, lcVersion, nextVersion } from "./lifecycle";

describe("жизненный цикл объекта", () => {
  it("версия по умолчанию 1.0.0, следующая — последнее число +1; статус по умолчанию — в работе", () => {
    expect(lcVersion({})).toBe("1.0.0");
    expect(nextVersion("1.0.0")).toBe("1.0.1");
    expect(nextVersion("2.3.9")).toBe("2.3.10");
    expect(nextVersion("черновик")).toBe("1.0.1");
    expect(lcStatus({})).toBe("in_work");
  });
});
