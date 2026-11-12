#!/usr/bin/env python3
"""Actual extracted app, disposable local account. No tenant, ACP or model calls."""
import argparse,hashlib,json,os,shutil,socket,subprocess,tarfile,tempfile,time,urllib.request,urllib.error,zipfile
from pathlib import Path

def extract(package,dest):
 if package.name.endswith('.tar.gz'):
  with tarfile.open(package)as source:source.extractall(dest,filter='data')
 else:
  with zipfile.ZipFile(package)as source:
   for row in source.infolist():
    p=dest/row.filename
    if p.resolve().is_relative_to(dest.resolve()) is False:raise ValueError('Archive path escapes')
    if row.is_dir():p.mkdir(parents=True,exist_ok=True);continue
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(source.read(row));p.chmod((row.external_attr>>16)&0o777 or 0o644)
def request(base,path,body=None,headers=None):
 r=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json',**(headers or {})})
 try:response=urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=20)
 except urllib.error.HTTPError as e:response=e
 with response:return response.status,dict(response.headers.items()),json.load(response)
def run(package,result,browser=False):
 checks=[]
 with tempfile.TemporaryDirectory(prefix='Teams native ')as tmp:
  root=Path(tmp);bundle=root/'download';bundle.mkdir();extract(package,bundle);binary=next(p for p in bundle.rglob('acp-teams-adapter.exe' if os.name=='nt' else 'acp-teams-adapter')if p.is_file());binary.chmod(0o755);home=root/'connection café 雪'
  env={k:v for k,v in os.environ.items()if not k.upper().startswith(('TEAMS_','OPENAI_','ANTHROPIC_','AZURE_','GOOGLE_','AMPLIFIER_','NODE_','ACP_'))};env['PATH']=str(root/'no-tools')
  def start():
   log=open(root/'server.log','ab');p=subprocess.Popen([str(binary),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env)
   deadline=time.monotonic()+180
   while time.monotonic()<deadline:
    if p.poll() is not None:raise AssertionError((root/'server.log').read_text(encoding='utf8',errors='replace')[-2000:])
    try:
     settings=json.loads((home/'native.json').read_text(encoding='utf8'));base=settings['origin'];status,_,_=request(base,'/auth/session')
     if status==200:return p,log,base
    except(OSError,ValueError):pass
    time.sleep(.1)
   p.kill();p.wait();log.close();raise AssertionError('Native app did not become ready after 180 seconds: '+(root/'server.log').read_text(encoding='utf8',errors='replace')[-4000:])
  def stop(p,log,base):
   p.terminate();p.wait(timeout=20);log.close()
   for _ in range(60):
    try:request(base,'/auth/session');time.sleep(.05)
    except OSError:break
   else:raise AssertionError('Child server survived native launcher termination')
  p,log,base=start()
  stop(p,log,base)
  checks.append('immediate close after endpoint readiness leaves no child server')
  p,log,base=start()
  try:
   config=(home/'adapter.json').read_bytes();c=json.loads(config);assert c['enabled'] is False and c['teams']['client_id']=='' and c['acp']['command']=='';checks.append('fresh package stays paused without tenant, agent or model')
   code,_,_=request(base,'/api/v1/status');assert code==401
   code,_,_=request(base,'/auth/session',headers={'Host':'evil.test','Origin':'http://evil.test'});assert code==403
   code,_,_=request(base,'/api/messages',{});assert code==503;checks.append('no management exposure or fabricated Teams availability')
   cap=json.loads((home/'secrets/first-account.json').read_text())['token'];password='Disposable Teams password 29';origin={'Origin':base}
   code,_,_=request(base,'/auth/first-account',{'setup_token':'wrong','password':password,'start_at_signin':False},origin);assert code==403
   if browser:
    fixture=root/'browser.json';fixture.write_text(json.dumps({'base':base,'cap':cap,'password':password}));subprocess.run([shutil.which('node'),str(Path(__file__).with_name('native-browser.mjs')),str(fixture)],check=True,timeout=90);checks.append('browser local setup lost reply and sign-in')
    code,headers,session=request(base,'/auth/login',{'password':password},origin)
   else:code,headers,session=request(base,'/auth/first-account',{'setup_token':cap,'password':password,'start_at_signin':False},origin)
   assert code==200 and session['authenticated'];cookie=next(v for k,v in headers.items()if k.lower()=='set-cookie').split(';')[0];auth={'Cookie':cookie,'X-CSRF-Token':session['csrf'],'Origin':base}
   saved=(home/'secrets/local-password.json').read_bytes();assert password.encode()not in saved and json.loads(saved)['encoded'].startswith('$argon2id$');checks.append('shared Argon2 account without system tools or secret argv')
   code,_,_=request(base,'/auth/first-account',{'setup_token':cap,'password':password+' changed','start_at_signin':False},origin);assert code==409;assert(home/'secrets/local-password.json').read_bytes()==saved
   code,_,_=request(base,'/api/v1/views',{}, {'Cookie':cookie,'Origin':base});assert code==401
   code,_,view=request(base,'/api/v1/views',{},auth);assert code in (200,201);checks.append('existing browser API requires session and CSRF; account create-only')
   code,_,status=request(base,'/api/v1/status',headers=auth);assert code==200 and status['enabled']is False and status['teams_configured']is False and status['active']==0
   code,_,startup=request(base,'/api/v1/startup',headers=auth);assert code==200 and startup['configured']is False;checks.append('no startup service or external agent activated')
   if os.name=='nt':
    subprocess.run([str(home/'runtime/node.exe'),str(Path(__file__).with_name('native-acp-lifetime.mjs')),str(home/'bin/acp-teams-adapter.exe'),base],check=True,timeout=30)
    checks.append('individual native ACP close stops its immediate grandchildren while Teams app stays available')
   reopened=subprocess.run([str(binary),'--home',str(home),'--no-browser'],env=env,capture_output=True,text=True,encoding='utf8',timeout=20);assert reopened.returncode==0,reopened.stderr;assert(home/'adapter.json').read_bytes()==config;checks.append('reopen proves same listener without duplicate process or config replacement')
   code,_,_=request(base,'/auth/logout',{},auth);assert code==200
   code,_,_=request(base,'/api/v1/status',headers=auth);assert code==401;checks.append('signout revokes only local browser session')
  finally:stop(p,log,base)
  p,log,base=start()
  try:
   assert(home/'adapter.json').read_bytes()==config and(home/'secrets/local-password.json').read_bytes()==saved
   code,h,session=request(base,'/auth/login',{'password':password},{'Origin':base});assert code==200
   cookie=next(v for k,v in h.items()if k.lower()=='set-cookie').split(';')[0];code,_,retained=request(base,'/api/v1/views/'+view['id'],headers={'Cookie':cookie});assert code==200 and retained['id']==view['id'];checks.append('restart retains account, configuration and saved views')
  finally:stop(p,log,base)
  checks.append('launcher shutdown contains its child server')
 result.parent.mkdir(parents=True,exist_ok=True);result.write_text(json.dumps({'checks':checks,'passed':len(checks),'package_sha256':hashlib.sha256(package.read_bytes()).hexdigest(),'production_operations':False,'startup_installation':False,'tenant_or_model_calls':0},indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--result',type=Path,required=True);p.add_argument('--browser',action='store_true');a=p.parse_args();run(a.package,a.result,a.browser)
