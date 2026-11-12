import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, save } from "../dist/config.js";
import { serve } from "../dist/server.js";

test(
  "dashboard sign-in, ordinary navigation and remote view control on desktop and phone",
  { skip: !process.env.PLAYWRIGHT_MODULE },
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    const home = mkdtempSync(join(tmpdir(), "teams-browser-"));
    const config = initialize(home);
    config.teams.client_id = "22222222-2222-4222-8222-222222222222";
    config.server.public_url = "https://teams.example.invalid";
    save(home, config);
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
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download Teams app package" }).click();
      const exported = await download;
      assert.equal(exported.suggestedFilename(), "teams-agent.zip");
      const expectedPackage = await fetch(url + "/api/v1/manifest.zip", { headers: { authorization: "Bearer " + token } });
      assert.deepEqual(readFileSync(await exported.path()), Buffer.from(await expectedPackage.arrayBuffer()));
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
      const question=service.store.questions.request('browser',{mode:'form',message:'Choose a count',requestedSchema:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:3}},required:['count']}});
      await page.locator('#page').selectOption('questions');await page.getByRole('heading',{name:'Choose a count'}).waitFor();
      await page.locator('[data-field=count]').fill('2');await page.getByRole('button',{name:'Send answer',exact:true}).click();assert.deepEqual(await question.answer,{action:'accept',content:{count:2}});
      const login=service.store.questions.request('browser',{mode:'url',message:'Open sign-in',url:'https://example.test/login',elicitationId:'external'});
      await page.locator('#refresh').click();await page.getByRole('link',{name:'Open provider page'}).waitFor();assert.equal(page.context().pages().length,1);
      await page.context().route('https://example.test/**',r=>r.fulfill({status:200,body:'Fixture'}));const popupPromise=page.context().waitForEvent('page');await page.getByRole('link',{name:'Open provider page'}).click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();assert.deepEqual(await login.answer,{action:'accept'});
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
