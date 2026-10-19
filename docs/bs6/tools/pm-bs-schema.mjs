// Логическая схема БД модели BS из метамодели: хранимые (Stored=True) свойства классов.
import fs from "node:fs";
const dir = "C:\\Program Files (x86)\\STU-Soft\\Business Studio 6\\Metadata\\1.0.0.5";
const t = fs.readFileSync(dir + "\\BizArch.mdm", "utf8");
const resx = new Map();
for (const m of fs.readFileSync(dir + "\\BizArch.ru.resx", "utf8").matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) resx.set(m[1], m[2].replace(/\s+/g, " ").trim());
const ruProp = (id) => (id ? resx.get(`${id}#PropertyView.Header`) ?? null : null);

const tables = [];
let i = 0;
for (;;) {
  const s = t.indexOf("<Class>", i);
  if (s < 0) break;
  const e = t.indexOf("</Class>", s);
  if (e < 0) break;
  const b = t.slice(s, e);
  i = e + 8;
  const id = /<ID>([0-9a-fA-F-]{36})<\/ID>/.exec(b)?.[1];
  const name = /<SystemName>([A-Za-z][A-Za-z0-9_]*)<\/SystemName>/.exec(b)?.[1];
  if (!id || !name) continue;
  const cols = [...b.matchAll(/<Param>([\s\S]*?)<\/Param>/g)]
    .map((x) => x[1])
    .map((pb) => ({
      id: /<ID>([0-9a-fA-F-]{36})<\/ID>/.exec(pb)?.[1] ?? null,
      name: /<SystemName>([A-Za-z][A-Za-z0-9_]*)<\/SystemName>/.exec(pb)?.[1] ?? null,
      type: /<Type>([^<]*)<\/Type>/.exec(pb)?.[1] ?? null,
      enumType: /<EnumType>([0-9a-fA-F-]{36})<\/EnumType>/.exec(pb)?.[1] ?? null,
      length: /<Length>([^<]*)<\/Length>/.exec(pb)?.[1] ?? null,
      stored: /<Stored>True<\/Stored>/.test(pb),
      multi: /<IsMultiCulture>True<\/IsMultiCulture>/.test(pb),
      readOnly: /<ReadOnly>True<\/ReadOnly>/.test(pb),
    }))
    .filter((p) => p.name && p.stored);
  if (cols.length === 0) continue;
  tables.push({ id, name, ru: resx.get(`${id}#RepositoryView.Header`) ?? null, cols: cols.map((c) => ({ ...c, ru: ruProp(c.id) })) });
}

const all = tables.reduce((n, x) => n + x.cols.length, 0);
fs.writeFileSync(process.env.TEMP + "/pm-bs-schema.json", JSON.stringify(tables, null, 1), "utf8");
console.log(`классов с хранимыми свойствами: ${tables.length}; колонок всего: ${all}`);
console.log("\n— крупнейшие таблицы —");
for (const x of [...tables].sort((a, b) => b.cols.length - a.cols.length).slice(0, 8)) console.log(`${x.name.padEnd(34)} ${String(x.cols.length).padStart(3)}  ${x.ru ?? ""}`);
for (const want of ["FunctionalObject", "ActivityInputOrOutput", "DiagramProperties", "SymbolStyleOfDiagramsStyle"]) {
  const x = tables.find((y) => y.name === want);
  if (!x) continue;
  console.log(`\n== ${x.name} — ${x.ru ?? ""} (${x.cols.length} колонок)`);
  for (const c of x.cols.slice(0, 14)) console.log(`   ${(c.ru ?? c.name ?? "").slice(0, 46).padEnd(48)} ${c.type}${c.enumType ? ` enum ${c.enumType.slice(0, 8)}…` : ""}${c.multi ? " multi" : ""}`);
}
