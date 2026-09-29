import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {active, describeWorkflowNode, eventDescription, filteredRuns, frameIndex, jsonSummary, kindOf, messageDisplay, messageHeading, messageSections, messageValue, needsAttention, rendererURL, sourceLabel, theme, workflowLayout, worldArtifactReader}
  from '../python/asys/dashboard_assets/dashboard.mjs';

test('world artifact reader preserves its job binding and returns text or integrity errors', async () => {
  const calls = [], reference = {path:'exports/candidate Ω/board.kicad_pcb',sha256:'a'.repeat(64),size:24};
  let runId = 'saved run', jobId = 'saved/job';
  const read = worldArtifactReader(runId,jobId,async url => {
    calls.push(new URL(url,'http://localhost'));
    return {ok:true,text:async()=>'(board "Ω")\n'};
  });
  runId = 'new run'; jobId = 'new job';
  assert.equal(await read(reference),'(board "Ω")\n');
  assert.equal(calls[0].pathname,'/api/runs/saved%20run/jobs/saved%2Fjob/world-artifact');
  assert.deepEqual(Object.fromEntries(calls[0].searchParams),{...reference,size:'24'});
  await assert.rejects(read({path:reference.path}),/Expected a world artifact/);
  assert.equal(calls.length,1);
  const changed = worldArtifactReader('r','j',async()=>({ok:false,status:400,json:async()=>({error:'World artifact content does not match its reference'})}));
  await assert.rejects(changed(reference),/content does not match/);
  const missing = worldArtifactReader('r','j',async()=>({ok:false,status:404,json:async()=>{throw Error('not JSON');}}));
  await assert.rejects(missing(reference),/World artifact read failed \(404\)/);
});

test('overview filters preserve named worker identity and distinguish history', () => {
  const rows = [{id:'1',system:'lab',worker_name:'repair',environment:'tools',status:'running',request:'Fix a clock'},
    {id:'2',system:'lab',worker_name:'review',status:'completed'},
    {id:'3',system:'other',worker_name:'explore',status:'paused'}];
  assert.deepEqual(filteredRuns(rows,{system:'lab',activity:'active',search:'repair clock'}),[rows[0]]);
  assert.deepEqual(filteredRuns(rows,{activity:'history'}),[rows[1]]);
  assert.equal(active('paused'),true);
  assert.equal(active('interrupted'),false);
  assert.equal(active('recovery-required'),false);
  assert.equal(active('recovering'),true);
  assert.equal(active('degraded'),true);
  assert.equal(kindOf({job:{type:'repair'},worker:{kind:'goal'}}),'goal');
  assert.equal(kindOf({job:{type:'custom-script'}}),'program');
  assert.equal(needsAttention({status:'running',activity:'waiting for human help'}),true);
  assert.equal(needsAttention({status:'detached'}),true);
  for(const status of ['degraded','recovering','recovery-required']) assert.equal(needsAttention({status}),true);
  assert.deepEqual(filteredRuns([{id:'a',kind:'swarm',status:'failed'},{id:'b',kind:'goal',status:'running'}],
    {kind:'swarm',activity:'attention'}).map(run=>run.id),['a']);
});

test('world history uses durable sequence and renderer must stay on dashboard origin', () => {
  assert.equal(frameIndex({index:47,sequence:47}),47);
  assert.equal(frameIndex({sequence:90}),90);
  assert.equal(rendererURL('/view/plot.mjs','http://localhost:9000/'),'http://localhost:9000/view/plot.mjs');
  assert.throws(()=>rendererURL('https://outside.example/module.mjs','http://localhost:9000/'),/dashboard/);
  assert.throws(()=>rendererURL('data:text/javascript,export default 1','http://localhost:9000/'),/dashboard/);
  assert.equal(theme.carta,'#EFE7D6');
  assert.match(eventDescription({type:'senate.phase_started',participant:'Reviewer',phase:'assess'}),/Reviewer.*assess/);
});

test('workflow layout follows actual edges despite saved node order, preserving forks and cycles', () => {
  const nodes=['join','right','start','left'].map(id=>({id}));
  const edges=[['start','left'],['start','right'],['left','join'],['right','join']].map(([source,target])=>({source,target}));
  const result=workflowLayout(nodes,edges), positions=Object.fromEntries(result.nodes.map(node=>[node.id,node]));
  assert.ok(positions.start.x<positions.left.x&&positions.left.x<positions.join.x);
  assert.equal(positions.left.x,positions.right.x);assert.notEqual(positions.left.y,positions.right.y);
  const cycle=workflowLayout(nodes,[...edges,{source:'join',target:'start'}]);
  assert.equal(cycle.nodes.length,4);assert.equal(cycle.edges.length,5);
  assert.ok(cycle.nodes.every(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)));
  assert.match(describeWorkflowNode({id:'fork',type:'parallelGateway'},[{source:'fork',target:'a'}]),/starts each outgoing branch/);
  assert.deepEqual(jsonSummary([1,2]),{type:'array',preview:'2 items'});
  assert.equal(jsonSummary('first\nsecond').long,true);
});

test('canonical transcript is complete and session labels use recorded names',()=>{
  const canonical='User\n{"mission":"Inspect","observation":{"cells":[1,2]},"custom":"Keep all content"}\n\nTool call: check\ncommand: echo ok\n';
  assert.equal(messageDisplay({role:'user',displayText:canonical,content:'must not replace canonical content'}),canonical);
  const long='Assistant\n'+('Complete recorded text. '.repeat(2000));
  assert.equal(messageDisplay({displayText:long}),long);
  for(const displayText of ['Assistant\n# Heading\n\nNormal **Markdown** text.','Thinking\nSaved text','Tool call: check\ncommand: git status\narbitrary: {"preserve":true}','Tool result: check (error)\nFailure detail\nError\nExit 1','Context compacted\nSaved summary',''])assert.equal(messageDisplay({displayText}),displayText);
  assert.throws(()=>messageDisplay({role:'assistant',content:'Missing API field'}),/missing displayText/);
  assert.equal(messageHeading({role:'user'}),'Input (User)');
  assert.equal(messageHeading({role:'assistant',content:[{type:'toolCall',name:'submit_plan'}]}),'Assistant · Tool call');
  assert.equal(messageHeading({role:'assistant',content:'Written response'}),'Assistant');
  assert.equal(messageHeading({role:'toolResult',toolName:'check'}),'Tool result · check');
  assert.equal(sourceLabel({title:'swarm/decisions/a/agent.json',memberName:'Builder (agent-001)',turn:2,stage:'review'}),'Builder (agent-001) · Turn 2 · review');
});

test('message presentation retains arbitrary values and every standard content block',()=>{
  const report={final:'All checks passed',exception:null,custom:{unexpected:[false,0,'retained']}};
  assert.deepEqual(messageValue(JSON.stringify(report)),report);
  assert.deepEqual(messageValue('```json\n'+JSON.stringify(report)+'\n```'),report);
  assert.equal(messageValue('# Heading\n**Written** text'),'# Heading\n**Written** text');
  const args={code:'module top;\nendmodule',command:'echo "literal"',arbitrary:[{enabled:false,value:0}],memory:{unusual:'Never discard this'}};
  const sections=messageSections({role:'assistant',content:[{type:'thinking',thinking:'Recorded thought'},{type:'text',text:'A normal response'},{type:'toolCall',name:'compile',arguments:args},{type:'custom',payload:report}],errorMessage:'Exact failure'});
  assert.deepEqual(sections,[{label:'Thinking',value:'Recorded thought'},{label:null,value:'A normal response'},{label:'compile',kind:'toolCall',value:args},{label:'Recorded custom',value:{payload:report}},{label:'Error',value:'Exact failure'}]);
  assert.deepEqual(messageSections({role:'toolResult',content:[{type:'text',text:JSON.stringify(report)}]}),[{label:null,value:report}]);
  assert.deepEqual(messageSections({role:'context',content:[{type:'text',text:'Saved compaction summary'}]}),[{label:null,value:'Saved compaction summary'}]);
  assert.deepEqual(messageSections({role:'assistant',content:[{type:'toolCall',name:'nothing',arguments:null}]}),[{label:'nothing',kind:'toolCall',value:null}]);
  assert.deepEqual(messageSections({role:'assistant',content:[{type:'thinking',thinking:'',thinkingSignature:'encrypted metadata'}]}),[]);
});

class CDP {
  constructor(child) {
    this.child=child; this.pending=new Map(); this.next=0; this.buffer='';
    child.on('exit',(code,signal)=>{
      for(const {reject,timer} of this.pending.values()){clearTimeout(timer);reject(Error(`Chrome exited: ${code ?? signal}`));}
      this.pending.clear();
    });
    child.stdio[4].on('data',chunk=>{
      this.buffer+=chunk;
      let end;
      while((end=this.buffer.indexOf('\0'))>=0) {
        const message=JSON.parse(this.buffer.slice(0,end)); this.buffer=this.buffer.slice(end+1);
        if(this.pending.has(message.id)) {
          const {resolve,reject,timer}=this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(timer);
          message.error ? reject(Error(message.error.message)) : resolve(message.result);
        }
      }
    });
  }
  send(method,params={},sessionId) {
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Timed out: ${method}`));},10000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdio[3].write(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}})+'\0');
    });
  }
}

const chrome=process.env.CHROME_BIN??'/opt/google/chrome/chrome';
test('real browser: unified views, isolated execution controls, replay and renderer disposal', {
  skip:process.env.ASYS_DASHBOARD_BROWSER!=='1'||!existsSync(chrome), timeout:65000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'asys-dashboard-browser-'));
  const assets=fileURLToPath(new URL('../python/asys/dashboard_assets/',import.meta.url));
  const controls=[],artifactReads=[];let memberListUnavailable=false,extraSource=false,customDesign=false;
  const customCSS=':root {--carta:#f3f5f7;--inchiostro:#172435;--verde:#006644;--goal:#008899;--senate:#8844aa;--swarm:#cc7700;--blu:#3355aa;--rosso:#aa3344;--giallo:#aa8800;--font:Georgia,serif;--mono:monospace;--task-shape:"M0 0L1 0L1 1L0 1Z";--gateway-shape:"M.5 0L1 .5L.5 1L0 .5Z"}';
  const sources=[{id:'source-one',path:'swarm/decisions/one/agent.json',title:'agent-001 · turn 0 · agent.json',member:'agent-001',turn:0},{id:'source-two',path:'swarm/decisions/two/agent.json',title:'agent-001 · turn 1 · agent.json',member:'agent-001',turn:1}];
  const structuredMessages=[{id:'u1',role:'user',displayText:'User\n'+JSON.stringify({mission:'Keep a garden alive',observation:{cells:Array.from({length:20},(_,i)=>({x:i,y:0,water:8}))},memory:{plan:'Build'}}),content:JSON.stringify({mission:'Keep a garden alive',observation:{cells:Array.from({length:20},(_,i)=>({x:i,y:0,water:8}))},memory:{plan:'Build'}})},{id:'a1',role:'assistant',displayText:'Tool call: submit_plan\nactions: [{"type":"build","kind":"garden"}]\nmemory: {"plan":"Check water"}',content:[{type:'toolCall',name:'submit_plan',arguments:{actions:[{type:'build',kind:'garden'}],memory:{plan:'Check water'}}}]}];
  const jobs=[['a','agent','assistant'],['g','goal','repair'],['s','senate','review'],['w','swarm','explore'],['p','program','check']]
    .map(([id,kind,type])=>({id,kind,type,name:type,status:'running',elapsed:'2m',metadata:{bpmn:{id:type}}}));
  const run={id:'r',name:'Design investigation',system:'lab',environment:'tools',status:'running',elapsed:'2m',request:'Check <script>unsafe()</script> text',jobs:{active:5,total:5}};
  const module=`export function mount(element,context) { window.mounts=(window.mounts||0)+1;window.worldTheme=context.theme;window.readSavedWorldArtifact=context.readWorldArtifact;
    element.innerHTML='<p id="fixture-frame"></p><button id="fixture-member">Inspect member</button><button id="fixture-artifact">Inspect artifact</button>';
    element.querySelector('#fixture-member').onclick=()=>context.selectMember('agent-001');
    element.querySelector('#fixture-artifact').onclick=()=>context.inspect({title:'Verified artifact',description:'Measured candidate evidence.',data:{score:8,source:'A long source line\\n'+('payload <script>never()</script> '.repeat(30)),nested:{checked:true}}});
    return { update(frame) {window.rendererUpdates=(window.rendererUpdates||0)+1;element.querySelector('#fixture-frame').textContent='Measured turn '+frame.turn;window.lastFrame=frame.turn}, dispose(){window.disposals=(window.disposals||0)+1;element.replaceChildren()} } }`;
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/custom.css'){res.setHeader('Content-Type','text/css');res.end(customCSS);return;}
      if(path==='/torus-view.mjs'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../asys-workers/worlds/torus/view.mjs',import.meta.url)));return;}
      if(path.startsWith('/design/default/')) {
        const name=path.slice('/design/default/'.length);
        if(!['styles.css','logo.svg'].includes(name)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'image/svg+xml');
        res.end(await readFile(new URL('../designs/default/'+name,import.meta.url)));return;
      }
      if(path==='/'||path.startsWith('/assets/')) {
        const name=path==='/'?'index.html':path.slice(8);
        if(!['index.html','dashboard.css','dashboard.mjs','workflow-viewport.mjs','design.mjs','console-selection.mjs','markdown.mjs','marked.mjs','content.mjs','senate.mjs','dagre.mjs'].includes(name)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
        let content=await readFile(join(assets,name),'utf8');
        if(path==='/'&&customDesign)content=content.replace('<!-- custom-design -->','<link rel="stylesheet" href="/custom.css">');
        res.end(content);return;
      }
      if(path==='/renderer.mjs'){res.setHeader('Content-Type','text/javascript');res.end(module);return;}
      if(path==='/api/runs/r/jobs/w/world-artifact') {
        artifactReads.push(Object.fromEntries(new URL(req.url,'http://localhost').searchParams));
        res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('(board "saved Ω")\n');return;
      }
      res.setHeader('Content-Type','application/json');
      let payload;
      if(path==='/api/runs')payload={scope:'Fixture systems',runs:[run,{...run,id:'old',name:'Archived check',system:'archive',status:'completed',jobs:{active:0,total:1}}]};
      else if(path==='/api/runs/r')payload={run,jobs,events:[{sequence:3,type:'run.started',time:'2026-09-23T10:00:00Z'}],workflow:{
        nodes:[{id:'repair',name:'explore',type:'serviceTask'},{id:'wait',name:'Wait for timer',type:'intermediateCatchEvent'},
          {id:'deadline',type:'boundaryEvent',attachedToRef:'repair'},{id:'split',name:'Split work',type:'parallelGateway'},
          {id:'explore',name:'Explore',type:'serviceTask'},
          {id:'future-review',name:'Future review',type:'serviceTask',workerType:'quality-review',workerKind:'senate'}],
        edges:[{source:'repair',target:'wait'},{source:'wait',target:'split'},{source:'deadline',target:'split'},
          {source:'split',target:'explore'},{source:'explore',target:'future-review'}],
        attachments:[{id:'attachment:deadline',source:'repair',target:'deadline',kind:'attachment'}]}};
      else if(path==='/api/runs/r/jobs/w/world')payload={snapshot:{turn:4,state:{score:8},metrics:{score:8}},frames:[{index:17,sequence:17,turn:1},{index:31,sequence:31,turn:4}],view:{module:'/renderer.mjs'},control:{pause:true,resume:false,cancel:true},events:Array.from({length:12},(_,i)=>({sequence:i+1,type:'swarm.tick',data:{turn:i}}))};
      else if(path==='/api/runs/r/jobs/w/members'&&memberListUnavailable){res.writeHead(404).end(JSON.stringify({error:'member list unavailable'}));return;}
      else if(path==='/api/runs/r/jobs/w/members')payload={members:[{id:'agent-001',status:'done',turn:4}]};
      else if(path==='/api/runs/r/jobs/w/members/agent-001')payload={id:'agent-001',status:'done',turn:4,decisions:4,transcript:{title:'Member transcript',sources:sources.slice(0,extraSource?2:1),text:'A private member decision\n'+Array.from({length:90},(_,i)=>'Reasoning and tool evidence '+i).join('\n')},hasConversation:true,output:{title:'Decision output',records:Array.from({length:40},(_,i)=>({id:'decision-'+i,title:'Decision '+i+' · result',type:'result',data:{actions:[{type:'build',x:i}],memory:{plan:'Check water'}}}))},data:{attempts:[{turn:4}]}};
      else if(path==='/api/runs/r/jobs/w/transcripts/source-one')payload={...sources[0],transcript:{title:'Saved agent.json',messages:structuredMessages,text:'Unused serialized fallback'}};
      else if(path==='/api/runs/r/jobs/w/frames/17')payload={turn:1,state:{score:12}};
      else if(path==='/api/runs/r/jobs/w/control') {
        let body='';for await(const part of req)body+=part;controls.push(JSON.parse(body));payload={accepted:true};
      } else if(/^\/api\/runs\/r\/jobs\/[agswp]$/.test(path)) {
        const job=jobs.find(job=>path.endsWith('/'+job.id));
        const data=job.kind==='goal'?{goal:{goal:'Repair the clock',sessions:[{attempt:1,phase:'verify',status:'running',result:{final:'Clock checked'}}]}}
          :job.kind==='senate'?{senate:{topic:'Review the repair',config:{princeps:{name:'Marcus'},senators:[{name:'Reviewer'}]},sessions:[{round:1,participant:'Reviewer',phase:'assess',status:'running',result:{final:'One concern remains'}}]}}
          :job.kind==='program'?{command:['python3','check.py'],result:{exit_code:0,final:'Checks passed'}}:job.kind==='swarm'?{result:{final:'Swarm final evidence'}}:{};
        payload={job:job.kind==='program'?{...job,detail:JSON.stringify({final:'Checks passed',inputs:['report.md','measurements.json'],arbitrary:'Keep this evidence'})}:job,kind:job.kind,worker:{kind:job.kind},transcript:{title:job.kind==='program'?'Output':'Transcript',text:job.name+' readable response',...(job.kind==='program'?{}:{messages:[{id:job.id+'-canonical',role:'assistant',displayText:'Assistant\n'+job.name+' readable response\nAll recorded details: arbitrary=preserved',content:job.name+' readable response\nAll recorded details: arbitrary=preserved'}]})},data};
      } else {res.writeHead(404).end(JSON.stringify({error:'missing fixture '+path}));return;}
      res.end(JSON.stringify(payload));
    }catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const child=spawn(chrome,['--headless=new','--ozone-platform=headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--no-first-run','--no-default-browser-check','--remote-debugging-pipe',`--user-data-dir=${root}/chrome`,'about:blank'],
    {stdio:['ignore','ignore','pipe','pipe','pipe'],env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:'',
      XAUTHORITY:join(root,'no-display-authority'),XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache')}});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{child.kill('SIGKILL');child.stdio[3].destroy();child.stdio[4].destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const cdp=new CDP(child), {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'}).catch(error=>{throw Error(error.message+'\n'+errors);});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{
    const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
  };
  const waitFor=async expression=>{
    const deadline=Date.now()+7000;
    while(!await evaluate(expression)) {if(Date.now()>deadline)throw Error(`Browser condition failed: ${expression}\n${await evaluate('document.body.innerText')}\n${errors}`);await new Promise(resolve=>setTimeout(resolve,40));}
  };
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`},sessionId);
  await waitFor('document.querySelectorAll("#runs tr").length===2');
  await evaluate('for (const [key,value] of [["activity","history"],["kind","swarm"]]) {const select=document.querySelector("#"+key+"-filter");select.value=value;select.dispatchEvent(new Event("change"));}');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("activity")'),'history');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("kind")'),'swarm');
  await cdp.send('Page.reload',{},sessionId);
  await waitFor('document.querySelector("#activity-filter")?.value==="history" && document.querySelector("#kind-filter")?.value==="swarm"');
  await evaluate('for (const [key,value] of [["activity","all"],["kind",""]]) {const select=document.querySelector("#"+key+"-filter");select.value=value;select.dispatchEvent(new Event("change"));}');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("activity")'),'all');
  assert.equal(await evaluate('new URL(location.href).searchParams.has("kind")'),false);
  await evaluate('document.querySelector("#system-filter").value="lab";document.querySelector("#system-filter").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("system")'),'lab');
  await cdp.send('Page.reload',{},sessionId);
  await waitFor('document.querySelector("#system-filter")?.value==="lab" && document.querySelectorAll("#runs tr").length===1');
  await evaluate('document.querySelector("[data-run=r] button").click()');
  await waitFor('document.querySelector("#transcript").textContent.includes("assistant readable")');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("system")'),'lab','opening a run retains the system filter');
  await evaluate('document.querySelector("#close-run").click()');
  assert.equal(await evaluate('new URL(location.href).searchParams.get("system")'),'lab','closing a run retains the system filter');
  await evaluate('document.querySelector("#system-filter").value="";document.querySelector("#system-filter").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('new URL(location.href).searchParams.has("system")'),false,'All systems clears the persisted filter');
  await evaluate('document.querySelector("[data-run=r] button").click()');
  await waitFor('document.querySelector("#transcript").textContent.includes("assistant readable")');
  assert.equal(await evaluate('document.querySelector("#run-request").textContent'),run.request);
  assert.equal(await evaluate('document.querySelector("#transcript .message-text").textContent'),'assistant readable response\nAll recorded details: arbitrary=preserved');
  assert.equal(await evaluate('document.querySelectorAll("#workflow [data-edge]").length'),6);
  assert.equal(await evaluate('document.querySelector("#workflow [data-node=wait]").getAttribute("role")'),'button');
  assert.equal(await evaluate(`document.querySelector('#workflow [data-edge="attachment:deadline"]').getAttribute('stroke-dasharray')`),'3 4');
  assert.equal(await evaluate('document.querySelector("#workflow [data-node=future-review] .work-mark").getAttribute("data-kind")'),'senate');
  await evaluate('document.querySelector("#workflow [data-node=repair]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
  await waitFor('document.querySelector("#typed-view").textContent.includes("Clock checked")');
  assert.equal(await evaluate('document.querySelector("#transcript .message-text").textContent'),'repair readable response\nAll recorded details: arbitrary=preserved');
  await evaluate('document.querySelector("[data-job=s]").click()');
  await waitFor('document.querySelector("#typed-view").textContent.includes("Reviewer")');
  assert.equal(await evaluate('document.querySelector("#transcript .message-text").textContent'),'review readable response\nAll recorded details: arbitrary=preserved');
  await evaluate('document.querySelector("[data-job=w]").click()');
  await waitFor('window.lastFrame===4');
  assert.equal(await evaluate('window.readSavedWorldArtifact({path:"exports/board.kicad_pcb",sha256:"a".repeat(64),size:19})'),'(board "saved Ω")\n');
  assert.deepEqual(artifactReads,[{path:'exports/board.kicad_pcb',sha256:'a'.repeat(64),size:'19'}]);
  await evaluate('document.querySelector("[data-node=split]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
  assert.match(await evaluate('document.querySelector("#inspector-description").textContent'),/Parallel gateway/);
  await evaluate('document.querySelector("#fixture-artifact").click()');
  await waitFor('document.querySelector("#inspector-tree .tree-text")');
  await evaluate('document.querySelector("#inspector-tree .tree-text").click()');
  assert.match(await evaluate('document.querySelector("#long-text").textContent'),/payload <script>never/);
  assert.equal(await evaluate('document.querySelectorAll("#inspector script,#console script").length'),0);
  await evaluate('document.querySelector("#world-section").scrollIntoView({block:"start"});document.querySelector("#fixture-member").focus({preventScroll:true})');
  const memberSelectionPage=await evaluate('scrollY');
  await evaluate('document.querySelector("#fixture-member").click()');
  await waitFor('document.querySelector("#transcript").textContent.includes("private member")');
  assert.equal(await evaluate('document.querySelector("#console-member").value'),'agent-001');
  assert.equal(await evaluate('scrollY'),memberSelectionPage,'selecting a world member must keep the map in view');
  assert.equal(await evaluate('document.activeElement.id'),'fixture-member','member selection retains keyboard focus');
  await evaluate('document.querySelector("#open-transcript").click()');
  assert.ok(await evaluate('(()=>{const r=document.querySelector("#console").getBoundingClientRect();return r.top<innerHeight&&r.bottom>0})()'),'Open transcript explicitly navigates to the console');
  await evaluate('document.querySelector("#console-follow").click();document.querySelector("#transcript").scrollTop=80;document.querySelector("#console-search").focus();');
  const stable=await evaluate('({page:window.scrollY,console:document.querySelector("#transcript").scrollTop,updates:window.rendererUpdates,focus:document.activeElement.id})');
  await new Promise(resolve=>setTimeout(resolve,5700));
  assert.deepEqual(await evaluate('({page:window.scrollY,console:document.querySelector("#transcript").scrollTop,updates:window.rendererUpdates,focus:document.activeElement.id})'),stable,'three unchanged polls must preserve page, console, focus and world DOM');
  const fonts=await evaluate(`Object.fromEntries(['transcript','events','output','world'].map(id=>[id,getComputedStyle(document.getElementById(id)).fontFamily]))`);
  assert.match(fonts.events,/mono|Courier/i);for(const id of ['transcript','output'])assert.match(fonts[id],/Helvetica/);
  assert.match(fonts.world,/Helvetica/);
  for(const tab of ['events','output']) {
    memberListUnavailable=tab==='output';
    if(tab==='output'){await evaluate('document.querySelector("#tab-output").click();document.querySelector("#output details").open=true');await waitFor('document.querySelector("#output .message-fields")');await evaluate('document.querySelector("#output .message-plain").open=true');}
    await evaluate(`document.querySelector('#tab-${tab}').click();document.querySelector('#${tab}').scrollTop=100000;document.querySelector('#console-search').focus()`);
    const expression=`({tab:document.querySelector('[data-console][aria-selected=true]').dataset.console,page:window.scrollY,scroll:document.querySelector('#${tab}').scrollTop,focus:document.activeElement.id,member:document.querySelector('#console-member').value,open:document.querySelectorAll('#output details[open]').length})`;
    const before=await evaluate(expression);await new Promise(resolve=>setTimeout(resolve,5700));
    assert.deepEqual(await evaluate(expression),before,'selected console tab and interior scroll survive polling, including member API failure');
  }
  memberListUnavailable=false;
  await evaluate('document.querySelector("#tab-transcript").click();document.querySelector("#console-follow").click()');
  assert.equal(await evaluate('document.querySelector("#console-follow").getAttribute("aria-pressed")'),'true');
  await evaluate('document.querySelector("#transcript").scrollTop=30');
  await waitFor('document.querySelector("#console-follow").getAttribute("aria-pressed")==="false"');
  await evaluate('document.querySelector("#console-search").value="tool evidence 4";document.querySelector("#console-search").dispatchEvent(new Event("input"))');
  assert.ok(await evaluate('document.querySelectorAll("#transcript mark").length>0'));
  await evaluate('document.querySelector("#console-search").value="";document.querySelector("#console-search").dispatchEvent(new Event("input"))');
  await evaluate('document.querySelector("#transcript-source").value="source-one";document.querySelector("#transcript-source").dispatchEvent(new Event("change"))');
  await waitFor('document.querySelectorAll("#transcript .conversation-message").length===2');
  assert.equal(await evaluate('document.querySelector("#transcript .message-text").textContent'),'Keep a garden alive');
  assert.equal(await evaluate('document.querySelector("#transcript .message-plain .message-text").textContent'),structuredMessages[0].displayText);
  assert.equal(await evaluate('document.querySelector("#transcript .message-plain").open'),false);
  assert.equal(await evaluate('document.querySelector("#transcript .message-heading strong").textContent'),'Input (User)');
  assert.match(await evaluate('document.querySelectorAll("#transcript .message-heading strong")[1].textContent'),/Assistant.*Tool call/);
  assert.match(await evaluate('document.querySelector("#transcript").textContent'),/submit_plan/);
  assert.equal(await evaluate('document.querySelector("#transcript .message-arguments").innerText.includes("build")'),true);
  assert.equal(await evaluate('document.querySelector("#transcript .message-arguments").innerText.includes("Check water")'),true);
  await evaluate('document.querySelector("#transcript .message-branch").open=true');
  await waitFor('document.querySelector("#transcript .message-branch .message-branch")');
  assert.ok(await evaluate('document.querySelector("#transcript .message-body").textContent.includes("Cells")'));
  assert.ok(await evaluate('document.querySelector("#transcript").clientHeight>=480'));
  assert.ok(await evaluate('document.querySelector("#transcript").getBoundingClientRect().top-document.querySelector("#console").getBoundingClientRect().top<150'));
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#transcript .message-arguments thead th")].map(n=>n.textContent)'),['Argument','Value']);
  assert.equal(await evaluate('document.querySelectorAll("#transcript .message-plain .message-text")[1].textContent'),structuredMessages[1].displayText);
  assert.equal(await evaluate(`[...document.querySelectorAll('#transcript .message-body')].some(n=>n.innerText.includes('{"actions"')||n.innerText.includes('{"mission"'))`),false);
  assert.equal(await evaluate('document.querySelector("#source-path").textContent'),sources[0].path);
  assert.equal(await evaluate('document.querySelectorAll("#transcript .json-tree,#transcript pre").length'),0);
  assert.equal(await evaluate('document.querySelector("#source-details").open'),false);
  assert.equal(await evaluate('[...document.querySelector("#transcript-source").options].some(option=>option.textContent.includes("agent.json"))'),false);
  await evaluate('document.querySelector("#transcript .message-details").click();document.querySelector("#transcript .message-details").focus()');
  assert.match(await evaluate('document.querySelector("#inspector-description").textContent'),/Original saved message/);
  extraSource=true;
  const pinned=await evaluate('({source:document.querySelector("#transcript-source").value,page:scrollY,scroll:document.querySelector("#transcript").scrollTop,open:document.querySelectorAll("#transcript .message-branch[open]").length})');
  await new Promise(resolve=>setTimeout(resolve,5700));
  assert.deepEqual(await evaluate('({source:document.querySelector("#transcript-source").value,page:scrollY,scroll:document.querySelector("#transcript").scrollTop,open:document.querySelectorAll("#transcript .message-branch[open]").length})'),pinned);
  assert.equal(await evaluate('document.querySelector("#transcript-source").options.length'),3);
  assert.equal(await evaluate('document.activeElement.className'),'message-details');
  await evaluate('document.querySelector("#console").scrollIntoView({block:"start"})');
  assert.ok(await evaluate('(()=>{const r=document.querySelector("#inspector").getBoundingClientRect();return r.top>=0&&r.top<innerHeight&&r.bottom>0})()'),'inspector remains beside console');
  const page=await evaluate('scrollY');
  await evaluate('document.querySelector("#inspector").scrollTop=10000');
  assert.equal(await evaluate('scrollY'),page,'inspector scroll is independent');
  assert.equal(await evaluate('!!(document.querySelector("#console").compareDocumentPosition(document.querySelector("#result-section"))&Node.DOCUMENT_POSITION_FOLLOWING)'),true);
  await evaluate('document.querySelector("[data-job=w]").click()');
  await waitFor('document.querySelector("#console-member").value==="" && document.querySelector("#transcript").textContent.includes("explore readable")');
  await evaluate('document.querySelector("#freeze").click()');
  assert.equal(await evaluate('document.querySelector("[data-control=pause]").disabled'),true);
  assert.equal(controls.length,0,'display freeze must never pause execution');
  await evaluate('document.querySelector("#freeze").click()');
  await waitFor('!document.querySelector("[data-control=pause]").disabled');
  await evaluate('document.querySelector("[data-control=pause]").click()');
  await waitFor('document.querySelector("#control-feedback").textContent.includes("requested")');
  assert.deepEqual(controls,[{action:'pause'}]);
  await evaluate('document.querySelector("#frame").value=0;document.querySelector("#frame").dispatchEvent(new Event("input"))');
  await waitFor('window.lastFrame===1');
  assert.equal(await evaluate('document.querySelector("[data-control=pause]").disabled'),true);
  await evaluate('document.querySelector("#world-live").click()');await waitFor('window.lastFrame===4');
  const desktop=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);
  if(process.env.ASYS_DASHBOARD_SCREENSHOTS)await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,'dashboard-desktop.png'),Buffer.from(desktop.data,'base64'));
  await evaluate('document.querySelector("[data-job=p]").click()');
  await waitFor('document.querySelector("#typed-view").textContent.includes("python3 check.py")');
  assert.equal(await evaluate('document.querySelector("#open-transcript").textContent'),'Open output');
  assert.equal(await evaluate('document.querySelector("#inspector-description").textContent.trim()'),'program worker · running.');
  await evaluate('document.querySelector("#job-activity .message-branch").open=true');
  await waitFor('document.querySelector("#job-activity").textContent.includes("Keep this evidence")');
  assert.equal(await evaluate('document.querySelector("#job-activity").textContent.includes("{\\\"final\\\"")'),false);
  assert.equal(await evaluate('window.disposals'),1);
  assert.equal(await evaluate('document.querySelector("#world-section").hidden'),true);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await evaluate('window.scrollTo(0,0)');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,'mobile body must not overflow');
  const mobile=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);
  if(process.env.ASYS_DASHBOARD_SCREENSHOTS)await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,'dashboard-mobile.png'),Buffer.from(mobile.data,'base64'));
  customDesign=true;
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  await cdp.send('Page.reload',{},sessionId);
  await waitFor('!!document.querySelector("#workflow .work-mark")');
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(243, 245, 247)');
  assert.match(await evaluate('getComputedStyle(document.body).fontFamily'),/Georgia/);
  assert.equal(await evaluate('document.querySelector("#workflow [data-kind=goal]").getAttribute("fill")'),'#008899');
  assert.equal(await evaluate('document.querySelector("#workflow [data-kind=goal]").getAttribute("d")'),'M0 0L1 0L1 1L0 1Z');
  assert.equal(await evaluate('document.querySelector("#workflow [data-kind=gateway]").getAttribute("d")'),'M.5 0L1 .5L.5 1L0 .5Z');
  await evaluate('document.querySelector("[data-job=s]").click()');
  await waitFor('!!document.querySelector(".senate-marker")');
  assert.equal(await evaluate('document.querySelector(".senate-marker").getAttribute("d")'),'M0 0L1 0L1 1L0 1Z');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".senate-marker")).fill'),'rgb(0, 102, 68)');
  await evaluate('document.querySelector("[data-job=w]").click()');
  await waitFor('!!window.worldTheme');
  assert.equal(await evaluate('worldTheme.taskPath'),'M0 0L1 0L1 1L0 1Z');
  assert.equal(await evaluate('worldTheme.verde'),'#006644');
  await evaluate(`(async()=>{const {mount}=await import('/torus-view.mjs');const target=document.createElement('div');target.id='themed-torus';document.body.append(target);mount(target,{theme:worldTheme}).update({state:{agents:['member'],positions:{member:{x:0,y:0}},settings:{width:1,height:1,radius:1,visible_artifacts:4},artifacts:[]}})})()`);
  assert.equal(await evaluate('document.querySelector("#themed-torus svg [data-agent]").getAttribute("d")'),'M0 0L1 0L1 1L0 1Z');
  assert.equal(await evaluate('document.querySelector("#themed-torus svg [data-agent]").getAttribute("fill")'),'#006644');
  await evaluate('document.querySelector("#themed-torus").remove();scrollTo(0,0)');
  if(process.env.ASYS_DASHBOARD_SCREENSHOTS){const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,'dashboard-custom-design.png'),Buffer.from(shot.data,'base64'));}
  if(process.env.ASYS_DASHBOARD_LIVE_URL) {
    const live=new URL(process.env.ASYS_DASHBOARD_LIVE_URL);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},sessionId);
    await cdp.send('Page.navigate',{url:live.href},sessionId);
    await waitFor('document.querySelectorAll("#runs tr").length>0');
    const runs=await evaluate('fetch("/api/runs").then(r=>r.json()).then(r=>r.runs)');
    const selected=[runs.find(run=>run.worker_name==='rainkeepers'&&run.status==='completed'),
      runs.find(run=>run.worker_name==='route-global'&&run.status==='completed'),
      runs.find(run=>run.worker_name==='route-local'&&run.status==='completed'),
      runs.find(run=>run.kind==='workflow'&&run.status==='completed')].filter(Boolean);
    assert.equal(selected.length,4,'live verification needs completed habitat, both route worlds and workflow runs');
    const shot=async name=>{
      if(!process.env.ASYS_DASHBOARD_SCREENSHOTS)return;
      const image=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);
      await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,name+'.png'),Buffer.from(image.data,'base64'));
    };
    await shot('live-overview');
    for(const run of selected) {
      const detail=await evaluate(`fetch('/api/runs/${run.id}').then(r=>r.json())`);
      for(const job of detail.jobs) {
        if(job.kind!=='swarm')continue;
        await cdp.send('Page.navigate',{url:live.href+`#run=${run.id}&job=${job.id}`},sessionId);
        await waitFor(`document.querySelector('#job-title').textContent===${JSON.stringify(job.name??job.type??job.id)} && !!document.querySelector('#world svg') && document.querySelector('#error').hidden`);
        await evaluate('document.querySelector("#world-section").scrollIntoView({block:"start"})');
        await shot('live-'+(run.worker_name??'workflow')+'-'+job.type);
        if(run.worker_name==='rainkeepers') {
          assert.match(await evaluate('document.querySelector(".habitat-phase").textContent'),/Drought evaluation complete/);
          assert.ok(await evaluate('document.querySelectorAll(".habitat-map [data-cell]").length>0'));
          await evaluate(`document.querySelector('.habitat-map [data-cell]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          assert.match(await evaluate('document.querySelector("#inspector-title").textContent'),/0, 0/);
          await evaluate(`document.querySelector('#world [data-member]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          await waitFor('document.querySelector("#console-member").value!==""');
          await waitFor('document.querySelector("#transcript").textContent.includes("Tool call")');
        } else if(run.worker_name==='route-global') {
          await evaluate(`document.querySelector('#world [data-id]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          assert.match(await evaluate('document.querySelector("#inspector-description").textContent'),/Checked score/);
          await evaluate(`document.querySelector('#world [data-member]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          await waitFor('document.querySelector("#console-member").value!==""');
        } else if(run.worker_name==='route-local') {
          await evaluate(`document.querySelector('#world [data-cell]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          assert.match(await evaluate('document.querySelector("#inspector-title").textContent'),/Cell/);
          await evaluate(`document.querySelector('#world [data-legend]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          assert.ok(await evaluate('document.querySelector("#inspector-description").textContent.length>40'));
          await evaluate(`document.querySelector('#world svg [data-agent]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
          await waitFor('document.querySelector("#console-member").value!==""');
        }
        assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,`mobile world must fit: ${job.type}`);
        if(run.worker_name==='rainkeepers')await shot('live-rainkeepers-mobile');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},sessionId);
      }
    }
  }
  await cdp.send('Browser.close');
});

test('real browser: workflow fit, zoom and pan survive live updates; long goals scroll independently', {
  skip:process.env.ASYS_DASHBOARD_BROWSER!=='1'||!existsSync(chrome), timeout:35000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'asys-dashboard-viewport-'));
  const assets=fileURLToPath(new URL('../python/asys/dashboard_assets/',import.meta.url));
  const goal='Repair the clock\n'+Array.from({length:100},(_,i)=>`Requirement ${i}: preserve the recorded evidence and verify the resulting clock behavior.`).join('\n');
  const run={id:'large',name:'Large workflow',system:'lab',environment:'tools',status:'running',elapsed:'2m',
    request:Array.from({length:40},(_,i)=>`Request detail ${i}: keep this complete request available.`).join('\n'),jobs:{active:2,total:2}};
  const jobs=[{id:'g',kind:'goal',type:'repair',name:'Repair',status:'running',metadata:{bpmn:{id:'goal'}}},
    {id:'a',kind:'agent',type:'inspect',name:'Inspect',status:'running',metadata:{bpmn:{id:'agent'}}}];
  const nodes=Array.from({length:24},(_,i)=>({id:i===0?'goal':i===1?'agent':`step-${i}`,name:`Engineering step ${i+1}`,type:'serviceTask'}));
  const workflow={nodes,edges:[...nodes.slice(1).map((node,i)=>({source:nodes[i].id,target:node.id})),{source:nodes.at(-1).id,target:nodes[2].id}]};
  let sessionStatus='running',detailPolls=0;
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/'||path.startsWith('/assets/')) {
        const name=path==='/'?'index.html':path.slice(8);
        if(!['index.html','dashboard.css','dashboard.mjs','workflow-viewport.mjs','design.mjs','console-selection.mjs','markdown.mjs','marked.mjs','content.mjs','senate.mjs','dagre.mjs'].includes(name)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
        res.end(await readFile(join(assets,name)));return;
      }
      if(path.startsWith('/design/default/')) {
        const name=path.slice('/design/default/'.length);
        if(!['styles.css','logo.svg'].includes(name)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'image/svg+xml');
        res.end(await readFile(new URL('../designs/default/'+name,import.meta.url)));return;
      }
      res.setHeader('Content-Type','application/json');
      let payload;
      if(path==='/api/runs')payload={scope:'Viewport fixture',runs:[run]};
      else if(path==='/api/runs/large'){detailPolls++;payload={run,jobs,workflow};}
      else if(/^\/api\/runs\/large\/jobs\/[ga]$/.test(path)) {
        const job=jobs.find(item=>path.endsWith('/'+item.id));
        payload={job,kind:job.kind,worker:{kind:job.kind},transcript:{text:'Saved response'},data:job.kind==='goal'?{goal:{goal,
          sessions:[{attempt:1,phase:'verify',status:sessionStatus,result:{final:sessionStatus==='running'?'Verification started':'Verification complete'}}]}}:{}};
      }else {res.writeHead(404).end(JSON.stringify({error:'missing fixture '+path}));return;}
      res.end(JSON.stringify(payload));
    }catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const child=spawn(chrome,['--headless=new','--ozone-platform=headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--no-first-run','--no-default-browser-check','--remote-debugging-pipe',`--user-data-dir=${root}/chrome`,'about:blank'],
  {stdio:['ignore','ignore','pipe','pipe','pipe'],env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:'',
    XAUTHORITY:join(root,'no-display-authority'),XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache')}});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{child.kill('SIGKILL');child.stdio[3].destroy();child.stdio[4].destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const cdp=new CDP(child),{targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=>{
    const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
  };
  const waitFor=async expression=>{
    const deadline=Date.now()+7000;
    while(!await evaluate(expression)){if(Date.now()>deadline)throw Error(`Browser condition failed: ${expression}\n${await evaluate('document.body.innerText')}\n${errors}`);await new Promise(resolve=>setTimeout(resolve,40));}
  };
  const view=()=>evaluate(`(()=>{const svg=document.querySelector('#workflow svg'),v=document.querySelector('#workflow-viewport').getBoundingClientRect(),m=svg.getScreenCTM();return [m.a,m.b,m.c,m.d,m.e-v.left,m.f-v.top]})()`);
  const assertView=(actual,expected,message)=>assert.ok(actual.every((value,i)=>Math.abs(value-expected[i])<0.01),`${message}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
  const fitted=`(()=>{const svg=document.querySelector('#workflow svg');if(!svg)return false;const v=document.querySelector('#workflow-viewport').getBoundingClientRect(),b=svg.getBBox(),m=svg.getScreenCTM();const points=[[b.x,b.y],[b.x+b.width,b.y+b.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(m));return points.every(p=>p.x>=v.left-1&&p.x<=v.right+1&&p.y>=v.top-1&&p.y<=v.bottom+1)})()`;
  const nodePoint=selector=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const mouse=(type,point,extra={})=>cdp.send('Input.dispatchMouseEvent',{type,...point,...extra},sessionId);
  const click=async selector=>{const point=await nodePoint(selector);await mouse('mouseMoved',point);await mouse('mousePressed',point,{button:'left',buttons:1,clickCount:1});await mouse('mouseReleased',point,{button:'left',buttons:0,clickCount:1});};
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/#run=large&job=a`},sessionId);
  await waitFor('document.querySelectorAll("#workflow [data-node]").length===24 && document.querySelector("#job-title").textContent==="Inspect"');
  await evaluate('document.querySelector("#workflow-viewport").scrollIntoView({block:"center"})');
  await waitFor(fitted);
  const panel=await evaluate(`(()=>{const p=document.querySelector('#workflow-viewport'),s=getComputedStyle(p);return {height:p.clientHeight,border:parseFloat(s.borderTopWidth),width:p.clientWidth,body:document.documentElement.scrollWidth,window:innerWidth}})()`);
  assert.ok(panel.height>=180&&panel.height<=650,'workflow panel has a useful bounded height');
  assert.ok(panel.border>0,'workflow viewport is visibly bordered');
  assert.ok(panel.width>300&&panel.body<=panel.window,'large graph does not widen the page');
  const initial=await view(),initialLevel=await evaluate('document.querySelector("#workflow-zoom-level").textContent');
  assert.ok(initial[0]<0.5,'large workflow initially fits at a reduced scale');
  await click('#workflow-zoom-in');
  const enlarged=await view();assert.ok(enlarged[0]>initial[0],'zoom in increases the graph scale');
  assert.notEqual(await evaluate('document.querySelector("#workflow-zoom-level").textContent'),initialLevel,'zoom level reflects the changed scale');
  await click('#workflow-zoom-out');
  assert.ok((await view())[0]<enlarged[0],'zoom out decreases the graph scale');
  await click('#workflow-fit');await waitFor(fitted);assertView(await view(),initial,'Fit restores the full graph');
  const start=await nodePoint('#workflow [data-node=goal] .workflow-node-hit'),pageBefore=await evaluate('scrollY');
  await mouse('mouseMoved',start);await mouse('mousePressed',start,{button:'left',buttons:1,clickCount:1});
  await mouse('mouseMoved',{x:start.x+35,y:start.y+28},{button:'left',buttons:1});
  await mouse('mouseReleased',{x:start.x+35,y:start.y+28},{button:'left',buttons:0,clickCount:1});
  const panned=await view();
  assert.ok(Math.abs(panned[4]-initial[4])>=30&&Math.abs(panned[5]-initial[5])>=23,'pointer drag pans the graph in both directions');
  assert.equal(await evaluate('document.querySelector("#job-title").textContent'),'Inspect','dragging from a task must not select it');
  assert.equal(await evaluate('scrollY'),pageBefore,'panning does not move the page');
  await click('#workflow [data-node=goal] .workflow-node-hit');
  await waitFor('document.querySelector("#job-title").textContent==="Repair" && !!document.querySelector(".goal-content")');
  assertView(await view(),panned,'selecting a task preserves the viewport');
  await evaluate('document.querySelector("#workflow [data-node=agent]").focus({preventScroll:true})');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  await waitFor('document.querySelector("#job-title").textContent==="Inspect"');
  assertView(await view(),panned,'keyboard task selection preserves the viewport');
  const pollsBefore=detailPolls;jobs[0].status='completed';
  await waitFor('document.querySelector("#workflow [data-node=goal]").getAttribute("aria-label").includes("completed")');
  assert.ok(detailPolls>pollsBefore,'status change came through a live poll');
  assertView(await view(),panned,'a status redraw preserves the viewport');
  await evaluate('document.querySelector("[data-job=g]").click()');
  await waitFor('!!document.querySelector(".goal-content")');
  const prose=await evaluate(`(()=>{const p=document.querySelector('.goal-content'),r=document.querySelector('#run-request');return {text:p.textContent,height:p.clientHeight,full:p.scrollHeight,overflow:getComputedStyle(p).overflowY,requestHeight:r.clientHeight,requestFull:r.scrollHeight}})()`);
  assert.equal(prose.text,goal,'complete goal content remains available');
  assert.ok(prose.height>80&&prose.height<=500&&prose.full>prose.height,'long goal has bounded vertical scrolling');
  assert.match(prose.overflow,/auto|scroll/);
  assert.ok(prose.requestHeight<=350&&prose.requestFull>prose.requestHeight,'long run request is also bounded');
  await evaluate('document.querySelector(".goal-content").scrollIntoView({block:"center"});document.querySelector(".goal-content").scrollTop=220');
  const goalScroll=await evaluate('({goal:document.querySelector(".goal-content").scrollTop,page:scrollY})');
  assert.ok(goalScroll.goal>0,'goal can be read by scrolling inside its panel');
  sessionStatus='completed';
  await waitFor('document.querySelector("#typed-view").textContent.includes("Verification complete")');
  assert.deepEqual(await evaluate('({goal:document.querySelector(".goal-content").scrollTop,page:scrollY})'),goalScroll,'new verification sessions preserve the goal reading position and page scroll');
  assertView(await view(),panned,'goal checkpoint updates preserve the workflow viewport');
  if(process.env.ASYS_DASHBOARD_SCREENSHOTS){const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,'dashboard-bounded-goal.png'),Buffer.from(shot.data,'base64'));}
  await evaluate('document.querySelector("#workflow-viewport").scrollIntoView({block:"center"})');
  await click('#workflow-fit');await waitFor(fitted);
  if(process.env.ASYS_DASHBOARD_SCREENSHOTS){const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);await writeFile(join(process.env.ASYS_DASHBOARD_SCREENSHOTS,'dashboard-workflow-fit.png'),Buffer.from(shot.data,'base64'));}
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await evaluate('document.querySelector("#workflow-viewport").scrollIntoView({block:"center"});document.querySelector("#workflow-fit").click()');
  await waitFor(fitted);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'bounded workflow remains inside the mobile page');
  await cdp.send('Browser.close');
});
