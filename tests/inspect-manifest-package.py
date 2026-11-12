"""Independent stdlib ZIP/PNG oracle; used by development tests, never installed."""
import importlib.util, io, json, struct, sys, zipfile, zlib
from pathlib import Path

def pixels(data, size):
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    offset, image, chunks = 8, b'', []
    while offset < len(data):
        length = struct.unpack_from('!I', data, offset)[0]
        name = data[offset+4:offset+8]
        payload = data[offset+8:offset+8+length]
        crc = struct.unpack_from('!I', data, offset+8+length)[0]
        assert zlib.crc32(name+payload) & 0xffffffff == crc
        chunks.append(name)
        if name == b'IHDR': assert struct.unpack('!2I5B', payload) == (size,size,8,6,0,0,0)
        if name == b'IDAT': image += payload
        offset += 12+length
    assert offset == len(data) and chunks == [b'IHDR',b'IDAT',b'IEND']
    raw = zlib.decompress(image)
    assert len(raw) == size*(1+size*4)
    return raw

def inspect(data, expected):
    spec = importlib.util.spec_from_file_location('original_recipe', Path(__file__).resolve().parents[1]/'ops/package-manifest.py')
    recipe = importlib.util.module_from_spec(spec); spec.loader.exec_module(recipe)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == ['manifest.json','color.png','outline.png']
        assert archive.testzip() is None
        value = json.loads(archive.read('manifest.json'))
        assert value == expected and value['manifestVersion'] == '1.22'
        assert value['icons'] == {'outline':'outline.png','color':'color.png'}
        for name,size,outline in [('color.png',192,False),('outline.png',32,True)]:
            assert pixels(archive.read(name),size) == pixels(recipe.icon(size,outline),size)
if __name__ == '__main__':
    inspect(sys.stdin.buffer.read(),json.loads(Path(sys.argv[1]).read_text()))
