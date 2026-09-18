import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

test('Simple navigation keeps every workspace reachable and labels the current destination', async () => {
  const bundle = await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{WorkspaceNavigation}from'./app/src/WorkspaceNavigation.jsx';function App(){const[s,set]=useState('Queue');return <WorkspaceNavigation activeSection={s} onNavigate={set}/>};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'jsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' })
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}})
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({content:await readFile('app/src/styles.css','utf8')})
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    assert.equal(await page.getByRole('button',{name:'Work',exact:true}).getAttribute('aria-current'),'page')
    assert.equal(await page.getByRole('button',{name:'Workers',exact:true}).isVisible(),false)
    await page.getByRole('button',{name:'More tools',exact:true}).click()
    for(const name of ['Projects','Team','Browser','Settings','Clients','Media','Workers','Activity','Decisions','Work']) {
      await page.getByRole('button',{name,exact:true}).click()
      assert.equal(await page.getByRole('button',{name,exact:true}).getAttribute('aria-current'),'page')
    }
    await page.screenshot({path:'/tmp/chimera-simple-navigation.png'})
    await page.getByRole('button',{name:'Workers',exact:true}).click()
    await page.getByRole('button',{name:'More tools',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'Workers',exact:true}).isVisible(),false)
    await page.getByRole('button',{name:'More tools',exact:true}).click()
    assert.equal(await page.getByRole('button',{name:'Workers',exact:true}).getAttribute('aria-current'),'page')
  } finally {await browser.close()}
})
