// Все перечисления метамодели BS: node pm-bs-enums.mjs
import fs from "node:fs";
const dir = "C:\\Program Files (x86)\\STU-Soft\\Business Studio 6\\Metadata\\1.0.0.5";
const t = fs.readFileSync(dir + "\\BizArch.mdm", "utf8");
const resx = new Map();
for (const m of fs.readFileSync(dir + "\\BizArch.ru.resx", "utf8").matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) resx.set(m[1], m[2].replace(/\s+/g, " ").trim());

const enums = [];
let i = 0;
for (;;) {
  const s = t.indexOf("<Enum>", i);
  if (s < 0) break;
  const e = t.indexOf("</Enum>", s);
  if (e < 0) break;
  const b = t.slice(s, e);
  i = e + 7;
  const id = /<ID>([0-9a-fA-F-]{36})<\/ID>/.exec(b)?.[1];
  const sn = /<SystemName>([A-Za-z][A-Za-z0-9_]*)<\/SystemName>/.exec(b)?.[1];
  if (!id || !sn) continue;
  const items = [...b.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]
    .map((m2) => ({ name: /<SystemName>([^<]*)<\/SystemName>/.exec(m2[1])?.[1] ?? "", value: /<Value>([^<]*)<\/Value>/.exec(m2[1])?.[1] ?? "" }))
    .filter((x) => x.name);
  enums.push({ id, name: sn, ru: resx.get(`${id}#RepositoryView.Header`) ?? null, items });
}
const keysOf = (id) => [...resx.keys()].filter((k) => k.startsWith(id + "#"));
const arrow = enums.find((e) => e.name === "ArrowTypes");
console.log(`перечислений: ${enums.length}; вариантов всего: ${enums.reduce((n, e) => n + e.items.length, 0)}`);
console.log(`ArrowTypes ${arrow?.id}: ключи ресурсов — ${keysOf(arrow?.id ?? "").slice(0, 6).join(" | ") || "нет"}`);
const pat = /Arrow|Input|Output|Control|Mechanism|Tunnel|Border|Boundary|Link|Activity|Influence|Relation|Diagram|Style/;
console.log("--- перечисления по теме стрелок/связей/диаграмм ---");
for (const e of enums.filter((e) => pat.test(e.name)).slice(0, 26)) {
  console.log(`${e.name.padEnd(30)} вариантов ${String(e.items.length).padEnd(4)} ${e.items.slice(0, 7).map((x) => x.name).join(", ")}`);
}
fs.writeFileSync(process.env.TEMP + "/pm-bs-enums.json", JSON.stringify(enums, null, 1), "utf8");
