// Двуязычный словарь перечислений BS: node pm-bs-enums-ru.mjs
import fs from "node:fs";
const dir = "C:\\Program Files (x86)\\STU-Soft\\Business Studio 6\\Metadata\\1.0.0.5";
const enums = JSON.parse(fs.readFileSync(process.env.TEMP + "/pm-bs-enums.json", "utf8"));
const resx = new Map();
for (const m of fs.readFileSync(dir + "\\BizArch.ru.resx", "utf8").matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) {
  resx.set(m[1], m[2].replace(/\s+/g, " ").trim());
}
const ru = (id, name) => resx.get(`${id}${name}#Description`) ?? resx.get(`${id}${name}#RepositoryView.Header`) ?? resx.get(`${id}#${name}#Description`) ?? null;
let known = 0;
for (const e of enums) {
  e.ru = ru(e.id, "") ? null : (resx.get(`${e.id}#RepositoryView.Header`) ?? null);
  for (const it of e.items) {
    it.ru = ru(e.id, it.name);
    if (it.ru) known++;
  }
}
fs.writeFileSync(process.env.TEMP + "/pm-bs-enums-ru.json", JSON.stringify(enums, null, 1), "utf8");
console.log(`перечислений ${enums.length}, вариантов ${enums.reduce((n, e) => n + e.items.length, 0)}, с русским именем ${known}`);
for (const name of ["TypesOfArrowSegmentEnding", "ArrowClasses", "ArrowSegmentTypes", "EdgeStyles", "ActivityCodeTypes", "DiagramDrawingModes"]) {
  const e = enums.find((x) => x.name === name);
  if (!e) continue;
  console.log(`\n== ${e.name} (${e.items.length})`);
  for (const it of e.items) console.log(`   ${it.name.padEnd(22)} ${it.ru ?? "—"}`);
}
