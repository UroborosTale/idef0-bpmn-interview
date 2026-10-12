import { describe, expect, it } from "vitest";
import { isPrivateAddress, safeWebhookFetch, validateWebhookUrl } from "../src/util/webhook.js";

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
