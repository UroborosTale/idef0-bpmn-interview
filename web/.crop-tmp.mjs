import { chromium } from "playwright";
const [src, dst, x, y, w, h, scale] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: Number(w) * Number(scale), height: Number(h) * Number(scale) } });
await page.setContent(`<body style="margin:0"><div style="width:${w*scale}px;height:${h*scale}px;background:url('file:///${src.replace(/\/g, "/")}') -${x*scale}px -${y*scale}px / ${3862*scale}px ${2110*scale}px no-repeat"></div></body>`);
await page.waitForTimeout(500);
await page.screenshot({ path: dst });
await browser.close();
