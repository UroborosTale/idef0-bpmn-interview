import { describe, expect, it } from "vitest";
import { isPrivateAddress, makeWebhookFetch, resolvePublic, safeWebhookFetch, validateWebhookUrl } from "../src/util/webhook.js";

describe("вебхуки: защита от SSRF", () => {
  it("IPv4-mapped, IPv4-compatible, NAT64 и широковещательные IPv6 к внутренним адресам отклоняются (URL пишет их в шестнадцатеричном виде)", () => {
    for (const u of [
      "http://[::ffff:127.0.0.1]:8787/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.5]/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::127.0.0.1]/",
      "http://[::1]/",
      "http://[::]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://169.254.169.254/",
      "http://localhost/",
      "file:///etc/passwd",
    ]) {
      expect(validateWebhookUrl(u).ok, u).toBe(false);
    }
  });

  it("публичные адреса проходят, в том числе IPv4-mapped публичный", () => {
    for (const u of ["https://example.com/hook", "https://8.8.8.8/hook", "https://[2606:4700::1111]/hook", "http://[::ffff:8.8.8.8]/hook"]) {
      expect(validateWebhookUrl(u).ok, u).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("разобранные адреса после DNS: частные и нераспознанные — запрещены", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "::ffff:7f00:1", "::ffff:a00:5", "fc00::1", "fec0::1", "не адрес"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("отправка на [::ffff:127.0.0.1] не уходит: ошибка до соединения", async () => {
    await expect(safeWebhookFetch("http://[::ffff:127.0.0.1]:9/", { method: "POST" })).rejects.toThrow(/внутренний\/служебный адрес/);
  });
});

describe("вебхуки: подмена DNS (rebinding)", () => {
  const fake = (...addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("имя, которое разрешается хотя бы в один внутренний адрес, отклоняется; публичные адреса проходят", async () => {
    await expect(resolvePublic("evil.example", fake("127.0.0.1"))).rejects.toThrow(/внутренний\/служебный адрес/);
    await expect(resolvePublic("evil.example", fake("8.8.8.8", "10.0.0.5"))).rejects.toThrow(/внутренний/); // достаточно одного частного из набора
    await expect(resolvePublic("evil.example", fake("::ffff:7f00:1"))).rejects.toThrow(/внутренний/);
    await expect(resolvePublic("evil.example", fake())).rejects.toThrow(/внутренний/);
    expect((await resolvePublic("ok.example", fake("8.8.8.8", "2606:4700::1111"))).map((a) => a.address)).toEqual(["8.8.8.8", "2606:4700::1111"]);
    // IP-литерал проверяется без обращения к DNS
    await expect(resolvePublic("[::ffff:127.0.0.1]", async () => { throw new Error("DNS не должен вызываться"); })).rejects.toThrow(/внутренний/);
    expect((await resolvePublic("8.8.4.4", async () => { throw new Error("DNS не должен вызываться"); }))[0].address).toBe("8.8.4.4");
  });

  it("соединение использует адрес из проверенного разрешения: имя, которое при соединении ведёт на внутренний адрес, не соединяется", async () => {
    // имя без записи в DNS: ошибка разрешения, а не соединение; для внутреннего адреса — отказ guard-а
    await expect(safeWebhookFetch("http://nonexistent-host-for-rebinding-test.invalid/", { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("вебхуки: передача", () => {
  it("тело, заголовки и метод доходят; статус возвращается; перенаправление не выполняется; сокет открывается по адресу из проверенного разрешения", async () => {
    const http = await import("node:http");
    const seen: { method?: string; ct?: string; body: string; host?: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, ct: req.headers["content-type"], body, host: req.headers.host });
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/second" }).end();
        } else res.writeHead(req.url === "/gone" ? 410 : 204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const resolved: string[] = [];
    // имя, которого нет в DNS, «разрешается» в локальный сервер — значит, сокет открыт по адресу из нашего разрешения
    const send = makeWebhookFetch(
      (url) => ({ ok: true as const, parsed: new URL(url) }),
      async (host) => {
        resolved.push(host);
        return [{ address: "127.0.0.1", family: 4 }];
      }
    );
    const ok = await send(`http://hook.example.test:${port}/in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "Привет" }) });
    expect(ok.status).toBe(204);
    expect(ok.ok).toBe(true);
    expect(seen[0]).toMatchObject({ method: "POST", ct: "application/json", body: '{"a":"Привет"}', host: `hook.example.test:${port}` });
    expect((await send(`http://hook.example.test:${port}/gone`, { method: "POST", body: "{}" })).status).toBe(410);
    const redirect = await send(`http://hook.example.test:${port}/redirect`, { method: "POST", body: "{}" });
    expect(redirect.status).toBe(302);
    expect(seen.filter((s) => s.method).length).toBe(3); // за перенаправлением никто не ходил
    expect(resolved).toContain("hook.example.test");

    // если разрешение отказывает, соединения нет
    const blocked = makeWebhookFetch((url) => ({ ok: true as const, parsed: new URL(url) }), async () => { throw new Error("запрещено"); });
    await expect(blocked(`http://hook.example.test:${port}/in`, { method: "POST", body: "{}" })).rejects.toThrow(/запрещено/);
    expect(seen.length).toBe(3);
    await new Promise((r) => server.close(r));
  });
});
