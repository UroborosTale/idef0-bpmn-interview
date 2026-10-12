import { describe, expect, it } from "vitest";
import { REFERENCE_PROCESSES } from "../src/reference/index.js";
import { generateBpmn } from "../src/pipeline/bpmn.js";
import { bpmnHosts } from "../src/shared/codes.js";
import { idef0Codes, labelSpec, layoutIdef0 } from "../src/shared/idef0Layout.js";

/**
 * «Золотые» снимки раскладки эталонных процессов: координаты блоков, ломаных стрелок, подписей, значков и пулов в читаемом виде,
 * по строке на элемент. Картинка зависит от шрифтов машины, а координаты — нет, поэтому любое непреднамеренное смещение (подписи,
 * маршруты, значки, пулы) сразу видно в diff. Намеренное изменение раскладки: `npx vitest run test/layoutGolden.test.ts -u`
 * и просмотр diff снимков в test/__golden__ перед коммитом.
 */
const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (p: [number, number][]) => p.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
const box = (b: { x: number; y: number; w: number; h: number }) => `${r1(b.x)},${r1(b.y)} ${r1(b.w)}×${r1(b.h)}`;
const diagramsOf = (m: any): (string | null)[] => [null, ...new Set(m.nodes.filter((n: any) => m.nodes.some((c: any) => c.idef0_parent === n.id)).map((n: any) => n.id as string))];

function idef0Snapshot(m: any): string {
  const codes = idef0Codes(m);
  const out: string[] = [];
  for (const d of diagramsOf(m)) {
    const lay = layoutIdef0(m, d);
    out.push(`# IDEF0 ${d === null ? "A0" : codes.get(d) ?? d}`);
    for (const f of lay.functions) out.push(`fn ${f.node.id} ${box(f.box)}`);
    for (const a of lay.arrows) {
      const l = labelSpec(a);
      out.push(`arrow ${a.key} [${pts(a.points)}]${l ? ` label@${r1(l.x)},${r1(l.y)}/${l.anchor} «${l.text}»` : ""}`);
    }
  }
  return out.join("\n") + "\n";
}

async function bpmnSnapshot(m: any): Promise<string> {
  const out: string[] = [];
  const codes = idef0Codes(m);
  for (const host of [null, ...bpmnHosts(m).filter((h: any) => m.nodes.some((n: any) => n.bpmn_scope === h.id))]) {
    const { diagram: d } = await generateBpmn(m, host ? host.id : null);
    out.push(`# BPMN ${host ? codes.get(host.id) ?? host.id : "общая схема"} ${r1(d.width)}×${r1(d.height)}`);
    for (const l of d.lanes) out.push(`lane ${l.roleId ?? "-"} ${box(l)}`);
    for (const s of d.shapes) out.push(`shape ${s.id} ${s.kind}${s.subtype ? "/" + s.subtype : ""} ${box(s)} «${s.name}»`);
    for (const e of d.edges) out.push(`edge ${e.id} ${e.from}→${e.to} [${pts(e.points)}]${e.label ? ` «${e.label}»` : ""}`);
    for (const x of d.extras) out.push(`extra ${x.kind} ${box(x)} «${x.name}»${x.link ? ` link[${pts(x.link)}]` : ""}`);
    for (const p of d.pools) out.push(`pool ${p.id} ${box(p)}`);
    for (const x of d.messages) out.push(`message ${x.id} ${x.from}→${x.to} [${pts(x.points)}]`);
  }
  return out.join("\n") + "\n";
}

describe("золотые снимки раскладки эталонов", () => {
  for (const [name, p] of Object.entries(REFERENCE_PROCESSES)) {
    it(`${name}: IDEF0 — блоки, стрелки и подписи`, async () => {
      await expect(idef0Snapshot(p.build())).toMatchFileSnapshot(`__golden__/idef0-${name}.txt`);
    });
    it(`${name}: BPMN — дорожки, фигуры, стрелки, значки, пулы`, async () => {
      await expect(await bpmnSnapshot(p.build())).toMatchFileSnapshot(`__golden__/bpmn-${name}.txt`);
    }, 120_000);
  }
});
