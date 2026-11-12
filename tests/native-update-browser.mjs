import fs from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let posts = 0;
  await page.goto(input.url);
  await page.getByRole("heading", { name: "Update Teams Connector" }).waitFor();
  assert(!page.url().includes("#"));
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.route("**/apply", async (route) => {
    posts++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort("connectionfailed");
  });
  await page
    .getByRole("button", { name: "Install update", exact: true })
    .click();
  await page
    .getByText("Update installed", { exact: false })
    .waitFor({ timeout: 240000 });
  assert.equal(
    posts,
    1,
    "The UI must inspect the same receipt, never redispatch after a lost reply",
  );
  assert.equal(
    await page.getByRole("link", { name: "Open connector" }).count(),
    1,
  );
  await page.getByRole("link", { name: "Open connector" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.origin !== new URL(input.url).origin);
  await page
    .getByRole("heading", { name: "Teams connection", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Native update browser: narrow-screen owner consent, fragment removal, one apply with lost reply, status-only terminal reconciliation and return link passed",
  );
} finally {
  await browser.close();
}
