// Runs the real hook and LabPage with controlled I/O; no application test routes.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const mocks={
 '@solana/wallet-adapter-react':'export const useWallet=()=>window.f.wallet;',
 '@/lib/client/signer-context':'export const useSigner=()=>window.f.context;',
 '@/lib/program':'export const getConnection=()=>window.f.base;',
 tee:`export const attestTee=async()=>1;export const currentTeeSession=k=>window.f.sessions[k.toBase58()]??null;export const resumeTeeSession=async()=>null;export const closeTeeSession=k=>{delete window.f.sessions[k.toBase58()];};export const sessionMatchesWallet=(s,k)=>!!s&&s.wallet===k&&s.expiresAt>Date.now()+60000;export const openTeeSession=k=>new Promise(resolve=>{window.f.finish=()=>{const s={wallet:k.toBase58(),connection:{name:k.toBase58()},expiresAt:Date.now()+3600000,attestedAt:Date.now()};window.f.sessions[k.toBase58()]=s;resolve(s);};});`,
 '@/components/ui/Button':`import React from 'react';export function Button({children,onClick,disabled,loading,type}){return <button type={type??'button'} disabled={disabled||loading} onClick={onClick}>{children}</button>;}`,
 'next/link':`import React from 'react';export default function Link({href,children}){return <a href={href}>{children}</a>;}`,
 '@/lib/anchor-errors':'export const messageFromAnchorError=e=>e.message??String(e);',
 '@/lib/format':'export const fmt={usd:String,pct:String,pct0:String};export const formatUsdc=String;export const formatWsol=String;',
 '@/lib/lab-scenario':`export const OUTCOME_EXPLAINED={repaid:'Repaid'};export const scenarioFrom=()=>({principal:100n,collateral:1n,startPrice:15000000000n,durationDays:7,interestBps:500,liquidationLtvBps:8000,dropDay:2,dropPercent:1,ltvAfterDropBps:5000,repayDay:3,outcome:'repaid'});`,
 '@/lib/private/lab':`export const readLabScenario=async()=>{window.f.reads++;if(window.f.readError)throw Error('read unavailable');return window.f.scenario;};export const requestScenario=async()=>{window.f.requests++;window.f.scenario={rounds:(window.f.scenario?.rounds??0)+1,ready:false,randomness:new Uint8Array(32)};};export const requestSponsoredScenario=async()=>{window.f.sponsors++;};export const registerForAchievements=async()=>{};export const claimAchievement=async()=>{};`,
};
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {usePrivate} from './lib/private/use-private';import {LabPage} from './components/private/LabPage';
window.f={sessions:{},context:{source:'wallet',setConnectOpen:()=>{}},wallet:{signMessage:async()=>new Uint8Array(64)},base:{getBalance:async()=>0},reads:0,requests:0,sponsors:0,scenario:null};const root=createRoot(document.getElementById('root'));let mode='hook',serial=0;function Hook(){const value=usePrivate();window.hook=value;return <div>{value.status}</div>;}const render=()=>flushSync(()=>root.render(mode==='hook'?<Hook/>:<LabPage key={serial}/>));window.setWallet=name=>{window.f.context={...window.f.context,signer:name?{publicKey:{toBase58:()=>name}}:null};render();};window.showLab=()=>{mode='lab';serial++;render();};window.setWallet('A');`;
const result=await build({stdin:{contents:source,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'io-fixtures',setup(b){
 b.onResolve({filter:/.*/},args=>{if(args.path==='./tee'&&args.importer.endsWith('use-private.ts'))return {path:'tee',namespace:'fixture'};if(Object.hasOwn(mocks,args.path))return {path:args.path,namespace:'fixture'};if(args.path.endsWith('.css'))return {path:args.path,namespace:'css-fixture'};});
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'tsx',resolveDir:process.cwd()}));b.onLoad({filter:/.*/,namespace:'css-fixture'},()=>({contents:'export default new Proxy({}, {get:(_,key)=>key});'}));
}}]});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?result.outputFiles[0].text:'<div id="root"></div><script src="/bundle.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.hook?.status==='idle');await page.evaluate(()=>{void window.hook.connect();});await page.waitForFunction(()=>window.hook.status==='signing');
 await page.evaluate(()=>window.setWallet('B'));assert.equal(await page.evaluate(()=>window.hook.er),null,'wallet switch immediately hides A connection');await page.evaluate(()=>window.f.finish());await page.waitForFunction(()=>window.hook.status==='idle');assert.equal(await page.evaluate(()=>window.hook.er),null,'late A sign-in cannot restore its connection');
 await page.evaluate(()=>{void window.hook.connect();});await page.waitForFunction(()=>window.hook.status==='signing');await page.evaluate(()=>window.f.finish());await page.waitForFunction(()=>window.hook.status==='ready');assert.equal(await page.evaluate(()=>window.hook.er.name),'B');
 await page.evaluate(()=>window.setWallet('A'));assert.equal(await page.evaluate(()=>window.hook.er),null,'completed B sign-in cannot cross to A');await page.evaluate(()=>window.setWallet(null));assert.equal(await page.evaluate(()=>window.hook.er),null,'disconnect clears connection');
 await page.evaluate(()=>{window.setWallet('B');window.f.scenario={rounds:4,ready:false,randomness:new Uint8Array(32)};window.showLab();});const waiting=page.getByRole('button',{name:'Waiting for randomness',exact:true});await waiting.waitFor();assert.ok(await waiting.isDisabled());await page.clock.runFor(4100);assert.ok(await page.evaluate(()=>window.f.reads)>=2);assert.equal(await page.evaluate(()=>window.f.sponsors+window.f.requests),0,'pending reload submits nothing');
 await page.evaluate(()=>{window.f.scenario={rounds:4,ready:true,randomness:new Uint8Array(32)};});await page.clock.runFor(2100);await page.getByRole('heading',{name:'Scenario 4',exact:true}).waitFor();await page.getByRole('button',{name:'Draw another',exact:true}).click();await page.waitForFunction(()=>window.f.requests===1);await page.clock.runFor(2100);await waiting.waitFor();assert.ok(await waiting.isDisabled());assert.equal(await page.evaluate(()=>window.f.sponsors),0,'existing rounds never use first sponsorship');
 await page.evaluate(()=>window.showLab());await waiting.waitFor();assert.equal(await page.evaluate(()=>window.f.requests),1,'remount resumes pending round without another draw');await page.evaluate(()=>{window.f.readError=true;});await page.clock.runFor(2100);await page.getByText('read unavailable',{exact:true}).waitFor();await page.getByRole('link',{name:'Continue with wallet-free learning'}).waitFor();assert.ok(await waiting.isDisabled());assert.deepEqual(errors,[]);
 console.log('PASS: actual usePrivate hook pending/completed wallet switches and disconnect; Lab pending reload, polling, sponsorship exclusion, duplicate prevention and read failure.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
