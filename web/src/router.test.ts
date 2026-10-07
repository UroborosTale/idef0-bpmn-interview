import { describe, expect, it } from "vitest";
import { parseRoute, routePath, type Route } from "./router";

describe("адреса страниц", () => {
  it("разбор адресов", () => {
    expect(parseRoute("/")).toEqual({ name: "list" });
    expect(parseRoute("/registry/")).toEqual({ name: "registry" });
    expect(parseRoute("/s/sess_1", "?tab=studio")).toEqual({ name: "workspace", id: "sess_1", tab: "studio" });
    expect(parseRoute("/s/sess_1")).toEqual({ name: "workspace", id: "sess_1", tab: undefined });
    expect(parseRoute("/campaign/c%201/tok")).toEqual({ name: "campaign", campaignId: "c 1", token: "tok" });
    expect(parseRoute("/unknown/path")).toEqual({ name: "list" });
  });

  it("адрес и разбор взаимно обратны", () => {
    const routes: Route[] = [
      { name: "list" },
      { name: "new" },
      { name: "workspace", id: "sess/с пробелом", tab: "studio" },
      { name: "workspace", id: "abc" },
      { name: "auditLog" },
      { name: "checklistRules" },
      { name: "campaign", campaignId: "x", token: "a/b" },
    ];
    for (const r of routes) {
      const [path, search = ""] = routePath(r).split("?");
      const back = parseRoute(path, search ? `?${search}` : "");
      expect(back, routePath(r)).toEqual(r.name === "workspace" ? { ...r, tab: r.tab } : r);
    }
  });
});
