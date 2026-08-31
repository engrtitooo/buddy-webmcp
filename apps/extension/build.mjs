import { build, context } from 'esbuild'; import { cp, mkdir, rm } from 'node:fs/promises'; import { resolve } from 'node:path';
const root=resolve(import.meta.dirname); const outdir=resolve(root,'dist'); const watch=process.argv.includes('--watch');
await rm(outdir,{recursive:true,force:true}); await mkdir(outdir,{recursive:true}); await cp(resolve(root,'public/manifest.json'),resolve(outdir,'manifest.json'));
const options={entryPoints:[resolve(root,'src/content.tsx')],bundle:true,outdir,entryNames:'content',format:'iife',target:'chrome149',minify:!watch,sourcemap:watch?'inline':false,legalComments:'none',loader:{'.tsx':'tsx','.ts':'ts'}};
if(watch){const ctx=await context(options);await ctx.watch();console.log('Buddy extension is rebuilding on changes.');}else await build(options);
