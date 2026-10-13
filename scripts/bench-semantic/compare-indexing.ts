/** Manual, cold-index comparison against an unmodified helper on the same corpus and machine.
 * bun scripts/bench-semantic/compare-indexing.ts --baseline=PATH --tool=PATH --model=PATH
 * No model downloads and no work shared between the two semantic indexes.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { defaultConfig } from "../../src/config.ts"
import { openDb } from "../../src/index/db.ts"
import { Indexer } from "../../src/index/indexer.ts"
import { SemanticIndexer } from "../../src/semantic/indexer.ts"
import { Embedder } from "../../src/semantic/helper.ts"
import { openSemanticDb, semanticDbPath, vectorValues } from "../../src/semantic/store.ts"
import { makeCorpus } from "../bench.ts"

const args = new Map(process.argv.slice(2).map(a => { const i = a.indexOf("="); return [a.slice(2,i),a.slice(i+1)] }))
const model = args.get("model"), baseline = args.get("baseline"), tool = args.get("tool")
if (!model || !baseline || !tool) throw new Error("pass --model, --baseline and --tool")
const work = args.get("work") ?? "work/index-comparison"
mkdirSync(work, {recursive:true})
const root=join(work,"corpus")
rmSync(root,{recursive:true,force:true})
makeCorpus(root,Number(args.get("files") ?? 400),7)
process.env.ZSEARCH_HOME=join(work,"data")
process.env.ZSEARCH_MODELS=dirname(model)
const config={...defaultConfig(), roots:[root], indexLoad:70, semantic:{enabled:true,images:false,code:false}}
const dbPath=join(work,"data","index.db")
rmSync(join(work,"data"),{recursive:true,force:true})
const db=openDb(dbPath)
let start=performance.now()
const main=await new Indexer(db,config,{inProcess:true}).run()
const extractionSeconds=(performance.now()-start)/1000
const results: Record<string,unknown>[]=[]
let reference:Map<string,Float32Array>|null=null
for(const [name,helper] of [["baseline",baseline],["optimized",tool]] as const){
  // Real production SemanticIndexer, its normal thread/load settings and a fresh vector store.
  for(const suffix of ["","-wal","-shm"])rmSync(semanticDbPath(dbPath)+suffix,{force:true})
  delete process.env.ZSEARCH_EMBED_DENSE_ATTN
  start=performance.now()
  const summary=await new SemanticIndexer(db,config,helper,{vectorVersion:1,embedder:opts=>new Embedder({...opts,tool:helper,model})}).run()
  const semanticSeconds=(performance.now()-start)/1000
  if(summary.status!=="done")throw new Error(JSON.stringify(summary))
  const store=openSemanticDb(semanticDbPath(dbPath))!
  const vectors=new Map<string,Float32Array>()
  for(const [hash,vec] of store.query("select hash,vec from vectors").values() as [Uint8Array,Uint8Array][]){
    vectors.set(Buffer.from(hash).toString("hex"),new Float32Array(vectorValues(vec,vec.length/2)!))
  }
  store.close()
  let minCosine=1, meanCosine=0
  for(const [hash,v] of vectors){
    const ref=reference?.get(hash)??v
    let dot=0, a=0, b=0
    for(let d=0;d<v.length;d++){dot+=ref[d]!*v[d]!;a+=ref[d]!**2;b+=v[d]!**2}
    const cos=dot/Math.sqrt(a*b);minCosine=Math.min(minCosine,cos);meanCosine+=cos/vectors.size
  }
  if(reference && (reference.size!==vectors.size || [...reference.keys()].some(h=>!vectors.has(h))))throw new Error("different passages")
  reference??=vectors
  const result={name,extractionSeconds,semanticSeconds,totalSeconds:extractionSeconds+semanticSeconds,mainFiles:main.added,...summary,minCosine,meanCosine}
  results.push(result);console.log(JSON.stringify(result))
  writeFileSync(join(work,"results.json"),JSON.stringify({platform:process.platform,arch:process.arch,results},null,2))
}
db.close()
