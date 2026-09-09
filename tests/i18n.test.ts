import assert from "node:assert/strict";
import test from "node:test";
import { getLocale, setLanguage, resolveLanguage, translate, type MessageKey } from "../src/lib/i18n.ts";
import { zh } from "../src/lib/translations.ts";

test("language selection honors explicit choice, Chinese variants, and unsupported languages", () => {
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("zh", "en-US"), "zh");
  for (const locale of ["zh", "zh-CN", "zh-TW", "zh-Hans"]) {
    assert.equal(resolveLanguage(null, locale), "zh");
  }
  assert.equal(resolveLanguage("invalid", "de-DE"), "en");
});

test("parameterized messages support Chinese word order and preserve literal user input", () => {
  assert.equal(translate("zh", "Auto {0} warm-up sent for {1}", ["5 小时", "测试账号"]), "已为 测试账号 发送 5 小时 自动预热请求");
  assert.equal(translate("en", "Switch failed: {0}", ["<script>{0}</script>"]), "Switch failed: <script>{0}</script>");
  assert.equal(translate("zh", "Imported {0}, skipped {1} (total {2})", [0, 2, 2]), "已导入 0 个，跳过 2 个（共 2 个）");
});

test("every translation preserves its source interpolation parameters", () => {
  const params = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim(), `Empty translation: ${key}`);
    assert.deepEqual(params(value), params(key), key);
    assert.equal(translate("en", key as MessageKey), key);
  }
});

test("failed preference persistence rejects instead of changing the displayed locale", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const before = getLocale();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { setItem: () => { throw new Error("Storage blocked"); } },
  } });
  try {
    await assert.rejects(setLanguage(before === "en-US" ? "zh" : "en"), /Storage blocked/);
    assert.equal(getLocale(), before);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
