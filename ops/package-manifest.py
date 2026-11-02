"""Build a Teams app package from generated manifest JSON. No service calls."""
import argparse,json,struct,zlib,zipfile
from pathlib import Path

def icon(size,outline=False):
 rows=[]
 for y in range(size):
  row=bytearray()
  for x in range(size):
   mark=(size//4<=x<3*size//4 and size//4<=y<3*size//8) or (7*size//16<=x<9*size//16 and size//4<=y<3*size//4)
   row.extend((255,255,255,255) if mark else ((0,0,0,0) if outline else (23,93,87,255)))
  rows.append(b'\0'+row)
 def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',zlib.crc32(name+data)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest',type=Path);p.add_argument('output',type=Path);a=p.parse_args();m=json.loads(a.manifest.read_text());assert m['manifestVersion']=='1.22';assert m['bots'][0]['botId'];
 with zipfile.ZipFile(a.output,'x',zipfile.ZIP_DEFLATED) as z:z.writestr('manifest.json',json.dumps(m,indent=2));z.writestr('color.png',icon(192));z.writestr('outline.png',icon(32,True))
 print('Teams package created:',a.output)
