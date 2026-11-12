import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(input.base+'/#setup='+input.cap);await page.getByRole('heading',{name:'Set up your Teams connector'}).waitFor();assert(!page.url().includes('setup='));
 if(process.env.UI_ARTIFACTS){await fs.mkdir(process.env.UI_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.UI_ARTIFACTS,'teams-native-setup.png')});}
 await page.route('**/auth/first-account',async route=>{const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionfailed');});
 await page.locator('#password').fill(input.password);await page.getByRole('button',{name:'Create local account',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#app').classList.contains('hidden')||document.querySelector('#native-title').textContent==='Sign in');
 if(await page.locator('#app').evaluate(e=>e.classList.contains('hidden'))){await page.locator('#password').fill(input.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});}
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('teams-setup')),null);
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByText('Paused · 0 conversations working').waitFor();
 if(process.env.UI_ARTIFACTS)await page.screenshot({path:path.join(process.env.UI_ARTIFACTS,'teams-native-paused-mobile.png')});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByText('Use the password you chose for this connector.').waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 if(process.env.UI_ARTIFACTS)await page.screenshot({path:path.join(process.env.UI_ARTIFACTS,'teams-native-login-mobile.png')});
 assert.deepEqual(errors,[]);console.log('Native browser: fragment removal, committed lost reply, preserved account, paused state, signout and mobile fit pass');
}finally{await browser.close();}
