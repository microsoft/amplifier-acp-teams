#!/usr/bin/env python3
"""Build a native Teams download. npm is build-time only, never user setup."""
import argparse,hashlib,importlib.util,json,os,plistlib,re,shutil,stat,subprocess,tarfile,tempfile,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
TARGETS={'x86_64-unknown-linux-gnu':('linux-x64','linux-x86_64'),'aarch64-unknown-linux-gnu':('linux-arm64','linux-aarch64'),'x86_64-apple-darwin':('macos-x64','macos-x86_64'),'aarch64-apple-darwin':('macos-arm64','macos-aarch64'),'x86_64-pc-windows-msvc':('windows-x64','windows-x86_64'),'aarch64-pc-windows-msvc':('windows-arm64','windows-aarch64')}
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);out=importlib.util.module_from_spec(spec);spec.loader.exec_module(out);return out

def package(binary,target,output,cache):
 if target not in TARGETS:raise ValueError('Unsupported native target')
 version=json.loads((ROOT/'package.json').read_text())['version'];kind,binary_target=TARGETS[target];windows=kind.startswith('windows');mac=kind.startswith('macos');output.mkdir(parents=True,exist_ok=True)
 if not binary.is_file() or binary.is_symlink():raise ValueError('Use an actual native build')
 if subprocess.check_output([str(binary.resolve()),'--version'],text=True).strip()!='acp-teams-adapter '+version:raise ValueError('Native/application version mismatch')
 guard=ROOT/'scripts/vendor/native-binary';meta=json.loads((guard/'vendor.json').read_text())
 if digest(guard/'native_binary.py')!=meta['sha256']:raise ValueError('Native binary guard changed')
 check=module('native_binary',guard/'native_binary.py');binary_info=check.inspect(binary.read_bytes(),binary_target)
 vendor=ROOT/'scripts/vendor/node';receipt=json.loads((vendor/'vendor.json').read_text())
 for file,expected in receipt['files'].items():
  if digest(vendor/file)!=expected:raise ValueError('Vendored Node support changed')
 support=module('node_support',vendor/'node_support.py')
 with tempfile.TemporaryDirectory(prefix='teams-package-') as temp:
  stage=Path(temp)/'package';stage.mkdir()
  if mac:
   content=stage/'Teams Connector.app/Contents';binroot=content/'MacOS';resources=content/'Resources';binroot.mkdir(parents=True);resources.mkdir(parents=True)
   (content/'Info.plist').write_bytes(plistlib.dumps({'CFBundleName':'Teams Connector','CFBundleDisplayName':'Teams Connector','CFBundleIdentifier':'com.microsoft.constellation.teams','CFBundleExecutable':'acp-teams-adapter','CFBundleVersion':version,'CFBundleShortVersionString':version,'CFBundlePackageType':'APPL','LSMinimumSystemVersion':'11.0','LSUIElement':True}))
  else:binroot=stage;resources=stage
  exe='acp-teams-adapter.exe' if windows else 'acp-teams-adapter';shutil.copyfile(binary,binroot/exe);(binroot/exe).chmod(0o755)
  node=support.prepare(kind,cache,resources/'runtime');check.inspect(Path(node['executable']).read_bytes(),binary_target,max_pe_bytes=256*1024*1024)
  actual=subprocess.check_output([node['executable'],'--version'],text=True).strip()
  if actual!='v'+node['version']:raise ValueError('Wrong bundled Node version')
  if mac:
   for executable in [binary,Path(node['executable'])]:
    libs=subprocess.check_output(['/usr/bin/otool','-L',str(executable)],text=True).splitlines()[1:]
    if any(not row.strip().split(' (',1)[0].startswith(('/usr/lib/','/System/Library/')) for row in libs):raise ValueError('Unexpected external Mac library')
  app=resources/'app';app.mkdir();shutil.copytree(ROOT/'dist',app/'dist')
  for name in ['package.json','package-lock.json','LICENSE','NOTICE']:shutil.copyfile(ROOT/name,app/name)
  npm=shutil.which('npm.cmd' if windows else 'npm')
  if not npm:raise ValueError('npm is needed by the package builder only')
  subprocess.run([npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=app,check=True)
  # npm command shims are not part of the installed product; modules and notices remain.
  for path in list((app/'node_modules').rglob('.bin')):
   if path.is_dir():shutil.rmtree(path)
  for path in resources.rglob('*'):
   if path.is_symlink() or path.suffix=='.node':raise ValueError('Unexpected linked/native module; qualify it explicitly')
  inventory={p.relative_to(resources).as_posix():digest(p) for p in sorted(resources.rglob('*')) if p.is_file()}
  (resources/'native-bundle.json').write_text(json.dumps({'schema':1,'component':'acp-teams-adapter','version':version,'target':target,'node':node,'package_lock_sha256':digest(ROOT/'package-lock.json'),'files':inventory},indent=2)+'\n')
  (stage/'START-HERE.txt').write_text('Open Teams Connector.app on Mac, acp-teams-adapter.exe on Windows, or acp-teams-adapter on Linux. Keep the download together.\nChoose a local password; Node, npm, Rust and WSL are not required. The connector starts paused and unconfigured. Teams app/tenant authorization, public HTTPS callback and an ACP agent still need your explicit setup. No tenant sign-in, model or message is started by installation.\nThis preview is unsigned/not notarized. Verify its published checksum; do not disable OS security controls.\n')
  filename=f'acp-teams-adapter-{version}-{target}'+('.tar.gz' if kind.startswith('linux') else '.zip');dest=output/filename
  if kind.startswith('linux'):
   with tarfile.open(dest,'w:gz')as out:
    for path in sorted(stage.rglob('*')):
     if path.is_file():out.add(path,arcname=path.relative_to(stage).as_posix(),recursive=False)
  else:
   with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED)as out:
    for path in sorted(stage.rglob('*')):
     if not path.is_file():continue
     entry=zipfile.ZipInfo(path.relative_to(stage).as_posix());entry.create_system=3;entry.external_attr=(stat.S_IFREG|(0o755 if path.stat().st_mode&0o111 else 0o644))<<16;entry.compress_type=zipfile.ZIP_DEFLATED;out.writestr(entry,path.read_bytes())
  sha=digest(dest);(output/(filename+'.sha256')).write_text(sha+'  '+filename+'\n');metadata={'schema':1,'component':'acp-teams-adapter','version':version,'target':target,'archive_sha256':sha,'binary_sha256':digest(binary),'binary':binary_info,'node':node,'package_lock_sha256':digest(ROOT/'package-lock.json'),'signed_or_notarized':False};(output/(filename+'.json')).write_text(json.dumps(metadata,indent=2)+'\n');return metadata
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--binary',type=Path,required=True);p.add_argument('--target',required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);a=p.parse_args();print(json.dumps(package(a.binary,a.target,a.output,a.cache),indent=2))
