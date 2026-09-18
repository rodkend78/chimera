import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientWorkspaceStore } from '../src/clients/workspace-store.mjs'

const original={id:'doc1',title:'Evidence',category:'Overview',kind:'document',status:'imported',origin:{label:'Source',ref:''},sha256:'a'.repeat(64),bytes:4,content:'safe'}
async function setup(alias){
 const directory=await mkdtemp(join(await realpath(tmpdir()),'client-import-compat-'))
 const catalog={schemaVersion:1,importedAt:'2026-09-07T22:00:00.000Z',clients:[{id:'C1',name:'Client',summary:'',status:'pilot',coverage:[],documents:[original,{...original,id:'doc2',status:'linked',content:null,duplicateOf:alias}]}]}
 await writeFile(join(directory,'catalog.json'),JSON.stringify(catalog))
 return directory
}
test('preserves a same-client duplicate reference without duplicating text',async()=>{
 const directory=await setup('doc1')
 try{const store=await ClientWorkspaceStore.open({directory});const detail=await store.detail('C1');assert.equal(detail.documents[1].duplicateOf,'doc1');assert.equal((await store.document('C1','doc1')).content,'safe')}finally{await rm(directory,{recursive:true,force:true})}
})
test('rejects missing or cyclic duplicate targets',async()=>{
 for(const id of ['missing','doc2']){const directory=await setup(id);try{await assert.rejects(ClientWorkspaceStore.open({directory}),{code:'CLIENT_WORKSPACE_CORRUPT'})}finally{await rm(directory,{recursive:true,force:true})}}
})
