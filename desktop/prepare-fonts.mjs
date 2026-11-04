import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop=dirname(fileURLToPath(import.meta.url));
const source=resolve(desktop,'..'); const root=resolve(source,'..');
const fonts=join(desktop,'assets','fonts');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(fonts,{recursive:true});
async function publish(name,bytes,expected) {
  if(digest(bytes)!==expected) throw new Error('Unexpected font bytes: '+name);
  const output=join(fonts,name);
  try {
    const existing=await readFile(output);
    if(digest(existing)!==expected) throw new Error('Existing font differs; preserved: '+output);
  } catch(error) {
    if(error.code!=='ENOENT') throw error;
    await writeFile(output,bytes,{flag:'wx'});
  }
}
await publish('inter-latin.woff2',await readFile(join(source,'node_modules/vitepress/dist/client/theme-default/fonts/inter-roman-latin.woff2')),'f7ab715caa2c78facb4334b211c81ee66f037cf9c99ca3f24acd543e84a93278');
const archive=join(root,'cache','fontsource-ibm-plex-mono-5.3.0.tgz');
let bytes;
try { bytes=await readFile(archive); } catch(error) {
  if(error.code!=='ENOENT') throw error;
  throw new Error('Missing pinned font archive. Run npm pack @fontsource/ibm-plex-mono@5.3.0 --pack-destination "'+join(root,'cache')+'". This preparation performs no downloads.');
}
if(digest(bytes)!=='60d3c0cfa549cb06fcb8867ee83f994d78e212abfac3bef3275436acb5c4d029') throw new Error('Pinned font archive hash differs; preserved for review.');
const tar=process.platform==='win32'?join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'):'tar';
const result=spawnSync(tar,['-xOf',archive,'package/files/ibm-plex-mono-latin-400-normal.woff2'],{windowsHide:true,shell:false,maxBuffer:1024*1024});
if(result.error||result.status!==0) throw new Error('Could not read the pinned font member with system tar.');
await publish('ibm-plex-mono-latin-400-normal.woff2',result.stdout,'08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7');
console.log('Prepared two verified app-local fonts; no downloads or global installation.');
