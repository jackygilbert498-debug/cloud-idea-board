import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const mobileStart = css.indexOf("@media (max-width: 720px)");
const mobileEnd = css.indexOf("@media (prefers-reduced-motion", mobileStart);
const mobile = css.slice(mobileStart, mobileEnd);

test("mobile interactive controls expose 44px touch targets", () => {
  assert.ok(mobileStart >= 0, "mobile breakpoint is missing");
  assert.match(
    mobile,
    /button,\s*\[role="button"\]\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
  );
  assert.match(
    mobile,
    /input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\)\s*\{[^}]*min-height:\s*44px/,
  );
  assert.match(mobile, /\.mobile-tabs\s*\{[^}]*height:\s*52px/);
  assert.match(mobile, /\.mobile-composer\s*\{[^}]*height:\s*54px/);
});
