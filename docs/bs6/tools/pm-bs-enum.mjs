// Выгрузка вариантов перечисления метамодели BS по GUID: node pm-bs-enum.mjs <guid>
import fs from "node:fs";
const mdm = "C:\\Program Files (x86)\\STU-Soft\\Business Studio 6\\Metadata\\1.0.0.5\\BizArch.mdm";
const id = (process.argv[2] ?? "").toLowerCase();
const t = fs.readFileSync(mdm, "utf8");
const at = t.toLowerCase().indexOf(`<id>${id}</id>`);
if (at < 0) {
  console.log(`GUID ${id} в BizArch.mdm не найден`);
  process.exit(1);
}
// элемент-владелец: ближайший открывающий тег перед ID
const before = t.slice(Math.max(0, at - 4000), at);
const tag = [...before.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>/g)].map((m) => m[1]).pop() ?? "?";
const win = t.slice(at, at + 60000);
const opts = [...win.matchAll(/<Option>([\s\S]*?)<\/Option>/g)]
  .map((m) => ({ name: /<Name>([^<]*)<\/Name>/.exec(m[1])?.[1] ?? "", value: /<Value>([^<]*)<\/Value>/.exec(m[1])?.[1] ?? "" }))
  .filter((o) => o.name || o.value);
console.log(`GUID ${id} (элемент <${tag}>): вариантов ${opts.length}`);
for (const o of opts.slice(0, 40)) console.log(`  ${String(o.value).padEnd(6)} ${o.name}`);
