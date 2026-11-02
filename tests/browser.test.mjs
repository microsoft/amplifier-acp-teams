import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../dist/config.js";
import { serve } from "../dist/server.js";

test(
  "dashboard sign-in, ordinary navigation and remote view control on desktop and phone",
  { skip: !process.env.PLAYWRIGHT_MODULE },
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    const home = mkdtempSync(join(tmpdir(), "teams-browser-"));
    initialize(home);
    const service = await serve(home);
    const url = "http://127.0.0.1:" + service.port,
      token = readFileSync(join(home, "secrets/control-token"), "utf8");
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.locator("#token").fill(token);
      await page.locator("#connect").click();
      await page.locator("#app:not(.hidden)").waitFor();
      await page
        .getByRole("heading", { name: "Teams connection" })
        .first()
        .waitFor();
      await page.locator("#page").selectOption("activity");
      await page.getByText("started", { exact: false }).first().waitFor();
      const view = service.store.db
        .prepare("SELECT * FROM views LIMIT 1")
        .get();
      const state = {
        page: "permissions",
        conversation: null,
        filter: "",
        focus: "filter",
      };
      const response = await fetch(url + "/api/v1/views/" + view.id, {
        method: "PUT",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: view.revision, state }),
      });
      assert.equal(response.status, 200);
      await page.waitForFunction(
        () =>
          document.querySelector("#page").value === "permissions" &&
          document.activeElement.id === "filter",
      );
      assert.equal(await page.locator("#token").inputValue(), "");
      mkdirSync("private", { recursive: true });
      await page.screenshot({
        path: "private/dashboard-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: "private/dashboard-mobile.png",
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await service.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
