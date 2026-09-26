import {installConsoleSelection} from './console-selection.mjs';
import {markdown} from './markdown.mjs';
import {mountSenate, senateParticipants} from './senate.mjs';
import {contentParts, outputRecords} from './content.mjs';
import {Graph, layout as layoutGraph} from './dagre.mjs';
import {readTheme,markAttributes} from './design.mjs';
import {mountWorkflowViewport} from './workflow-viewport.mjs';

const TERMINAL = new Set(['completed', 'done', 'failed', 'cancelled', 'interrupted', 'recovery-required']);
const KINDS = new Set(['agent', 'goal', 'senate', 'swarm', 'program', 'human']);
export const theme = readTheme();
export function workColor(kind) {
  return ({agent:theme.verde,goal:theme.goal,senate:theme.senate,swarm:theme.swarm,
    program:theme.blu,human:theme.rosso,gateway:theme.giallo,event:theme.inchiostro})[kind]??theme.rail;
}
export function active(status) { return !TERMINAL.has(status); }
export function needsAttention(run) {
  return ['failed', 'detached', 'unavailable', 'interrupted', 'degraded', 'recovering', 'recovery-required'].includes(run.status) || Boolean(run.error)
    || /waiting|human help|exhausted|unavailable|retry|failed/i.test(String(run.activity ?? run.detail ?? ''));
}
export function kindOf(value = {}) {
  const kind = value.kind ?? value.worker?.kind ?? value.job?.kind ?? value.job?.type ?? value.type;
  return KINDS.has(kind) ? kind : 'program';
}
export function filteredRuns(runs, {system = '', activity = 'all', kind = '', search = ''} = {}) {
  const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return runs.filter(run => (!system || run.system === system)
    && (!kind || (run.kind ?? run.worker_kind ?? (run.workflow ? 'workflow' : 'program')) === kind)
    && (activity === 'all' || (activity === 'attention' ? needsAttention(run) : active(run.status) === (activity === 'active')))
    && words.every(word => [run.id, run.name, run.system, run.environment, run.worker_name, run.request,
      run.status, run.activity].filter(Boolean).join(' ').toLocaleLowerCase().includes(word)));
}
export function eventDescription(event = {}) {
  const data = event.data ?? event;
  const parts = [String(event.type ?? 'event').replaceAll('_', ' ').replaceAll('.', ' · ')];
  if (data.participant) parts.push(data.participant);
  if (data.phase) parts.push(data.phase);
  if (data.turn != null) parts.push(`turn ${data.turn}`);
  if (data.attempt != null) parts.push(`attempt ${data.attempt}`);
  if (data.reason) parts.push(String(data.reason));
  return parts.join(' / ');
}
export function frameIndex(frame) { return frame.index ?? frame.sequence; }
export function rendererURL(value, origin) {
  const url = new URL(value, origin);
  if (url.origin !== new URL(origin).origin || !['http:', 'https:'].includes(url.protocol)) {
    throw Error('World renderer must be served by this dashboard.');
  }
  return url.href;
}
export function workflowLayout(nodes, edges) {
  const graph=new Graph({multigraph:true});
  graph.setGraph({rankdir:'LR',nodesep:48,ranksep:64,edgesep:24,marginx:48,marginy:32});
  const byId=new Map(nodes.map(node=>[node.id,node]));
  for(const node of nodes)graph.setNode(node.id,{width:200,height:108});
  const valid=edges.filter(edge=>byId.has(edge.source)&&byId.has(edge.target));
  for(const [index,edge] of valid.entries()) {
    const branch=String(byId.get(edge.source).type).toLowerCase().includes('exclusivegateway');
    graph.setEdge(edge.source,edge.target,{width:branch?76:0,height:branch?18:0,labelpos:'c'},String(index));
  }
  if(nodes.length)layoutGraph(graph);
  const routed=valid.map((edge,index)=>({...edge,...graph.edge({v:edge.source,w:edge.target,name:String(index)})}));
  const returns=routed.filter(edge=>graph.node(edge.target).x<=graph.node(edge.source).x);
  const top=returns.length*44;
  const placed=nodes.map(node=>({...node,x:graph.node(node.id).x,y:graph.node(node.id).y+top}));
  const locations=new Map(placed.map(node=>[node.id,node]));
  for(const edge of routed) {
    const from=locations.get(edge.source),to=locations.get(edge.target),index=returns.indexOf(edge);
    if(index<0) {
      const points=edge.points.map(point=>({...point,y:point.y+top}));
      edge.points=[{x:from.x,y:from.y},{x:points[0].x,y:from.y},...points.slice(1,-1),
        {x:points.at(-1).x,y:to.y},{x:to.x,y:to.y}];
      if(edge.y!=null)edge.y+=top;
    } else {
      // A backward edge must leave the task on the right and re-enter its
      // destination on the left. Dagre's rectangle ports can place both ends
      // on the incoming rail, making a revision task look like a dead end.
      // Reserve a separate return lane above the graph and use the clear gaps
      // between node columns for the vertical segments, including self-loops.
      const lane=28+index*44,exit=from.x+128,entry=to.x-128,bend=20;
      edge.points=[{x:from.x,y:from.y},{x:exit-bend,y:from.y},
        {x:exit,y:from.y-bend},{x:exit,y:lane+bend},{x:exit-bend,y:lane},
        {x:entry+bend,y:lane},{x:entry,y:lane+bend},{x:entry,y:to.y-bend},
        {x:entry+bend,y:to.y},{x:to.x,y:to.y}];
      edge.returning=true;
      edge.label=`Return to ${to.name??to.id}`;
      edge.labelX=from.x+108;edge.labelY=lane-8;
    }
  }
  return {width:Math.max(450,graph.graph().width??0,...routed.flatMap(edge=>edge.points.map(point=>point.x+24))),
    height:Math.max(180,(graph.graph().height??0)+top),nodes:placed,edges:routed};
}

export function workflowLabel(value, width=27) {
  const lines=[];
  for(const word of String(value).split(/\s+/)) {
    if(lines.length&&lines.at(-1).length+word.length+1<=width)lines[lines.length-1]+=' '+word;
    else lines.push(word);
  }
  return lines;
}

export function workflowKind(node, job) {
  if(node.type?.toLowerCase().includes('usertask'))return 'human';
  return job?.kind??node.workerKind??(KINDS.has(node.workerType)?node.workerType:node.type?.toLowerCase().includes('scripttask')?'program':'unknown');
}

export function workflowJob(node, jobs) {
  const identity=job=>job.metadata?.bpmn?.id??job.metadata?.activity_id??job.activityId;
  return jobs.findLast(job=>identity(job)===node.id)??jobs.findLast(job=>identity(job)==null
    &&(job.metadata?.name===node.id||job.name===node.id||job.name===node.name));
}

export function describeWorkflowNode(node, edges = []) {
  const kind = String(node.type ?? '').toLowerCase();
  const incoming = edges.filter(edge => edge.target === node.id).length;
  const outgoing = edges.filter(edge => edge.source === node.id).length;
  if (kind.includes('parallelgateway')) return incoming > 1
    ? 'Parallel gateway. This join waits for its incoming branches before continuing.'
    : 'Parallel gateway. This fork starts each outgoing branch. The branches can run concurrently.';
  if (kind.includes('exclusivegateway')) return 'Exclusive gateway. The workflow selects an outgoing branch using its configured conditions or default route.';
  if (kind.includes('inclusivegateway')) return 'Inclusive gateway. One or more branches may be selected according to the configured conditions.';
  if (kind.includes('gateway')) return `Gateway. This control point connects ${incoming} incoming and ${outgoing} outgoing branches. Its workflow definition determines routing.`;
  if (kind.includes('startevent')) return 'Start event. Execution enters the workflow here.';
  if (kind.includes('endevent')) return 'End event. Ends this path when reached.';
  if (kind==='boundaryevent') return `Boundary event attached to ${node.attachedToRef??'its activity'}. Its trigger controls this outgoing path.`;
  if (kind.includes('event')) return 'Workflow event. This point represents a configured trigger, wait, or completion condition.';
  if (kind==='callactivity') return `Call activity. Runs the process ${node.calledElement??'selected by its definition'}.`;
  if (['subprocess','adhocsubprocess','transaction'].includes(kind)) return 'Workflow scope. Its nested activities retain their own identities and connections.';
  if (kind.includes('usertask')) return 'Human task. Execution waits for a person to provide the configured response.';
  return 'Worker task. Select it to inspect the execution and read its transcript or output.';
}

export function jsonSummary(value) {
  if (value === null) return {type:'null', preview:'null'};
  if (Array.isArray(value)) return {type:'array', preview:`${value.length} ${value.length === 1 ? 'item' : 'items'}`};
  if (typeof value === 'object') { const count=Object.keys(value).length;return {type:'object',preview:`${count} ${count===1?'field':'fields'}`}; }
  if (typeof value === 'string') return {type:'string', preview:value.replace(/\s+/g,' ').slice(0,100)+(value.length>100?'…':''), long:value.length>180||value.includes('\n')};
  return {type:typeof value, preview:String(value)};
}

/** The backend uses the same saved-conversation formatter as asys top. */
export function messageDisplay(message) {
  if(typeof message.displayText!=='string')throw new TypeError('Transcript API message is missing displayText.');
  return message.displayText;
}
/** Decode structured text without guessing which fields matter. */
export function messageValue(value) {
  if(typeof value!=='string')return value;
  const text=value.trim(),fenced=text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  try {const parsed=JSON.parse(fenced?fenced[1]:text);if(parsed!==null&&typeof parsed==='object')return parsed;}catch{}
  return value;
}
/** Preserve every content block; only the standard message/block envelope is removed. */
export function messageSections(message) {
  const sections=[],append=(label,value)=>sections.push({label,value:messageValue(value)});
  const blocks=Array.isArray(message.content)?message.content:[message.content];
  for(const block of blocks) {
    if(block===undefined)continue;
    if(block===null||typeof block!=='object'){append(null,block);continue;}
    const rest={...block};delete rest.type;
    if(block.type==='text'&&typeof block.text==='string') {append(null,block.text);delete rest.text;}
    else if(block.type==='thinking'&&typeof block.thinking==='string') {if(block.thinking)append('Thinking',block.thinking);delete rest.thinking;}
    else if(block.type==='toolCall') {
      sections.push({label:block.name??'unnamed tool',kind:'toolCall',value:messageValue(Object.hasOwn(block,'arguments')?block.arguments:{})});delete rest.name;delete rest.arguments;
    } else {append(block.type?`Recorded ${block.type}`:'Recorded content',rest);continue;}
    for(const key of ['id','signature','thinkingSignature','textSignature'])delete rest[key];
    if(Object.keys(rest).length)sections.push({label:'Block details',value:rest,collapsed:true});
  }
  if(message.errorMessage!==undefined)append('Error',message.errorMessage);
  if(message.details!==undefined)sections.push({label:'Result details',value:message.details,collapsed:true});
  return sections;
}

/** Inline, lossless record display. All children remain reachable in this message. */
export function messageRecord(document,value,{expanded=new Set(),path='$',label=null,collapsed=false,table=false}={}) {
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
  const fieldLabel=key=>{const label=String(key).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replaceAll('_',' ');return label.charAt(0).toUpperCase()+label.slice(1);};
  const small=input=>{
    let leaves=0,characters=0;
    const visit=(item,depth)=>{
      if(depth>3)return false;
      if(item!==null&&typeof item==='object')return Object.keys(item).length<=6&&Object.values(item).every(child=>visit(messageValue(child),depth+1));
      leaves++;characters+=String(item).length;return leaves<=12&&characters<=1200;
    };return visit(input,0);
  };
  const render=(input,key,location,fold,forceFold=false,literal=false)=>{
    const code=literal||/^(code|command|script|source|patch|diff|stdout|stderr)$/i.test(key??'');
    const item=code?input:messageValue(input),compound=item!==null&&typeof item==='object';
    const node=make('div',compound?'message-record':'message-value');node.dataset.valuePath=location;
    if(!compound) {
      node.classList.toggle('message-short',key!=null&&(typeof item!=='string'||item.length<=70&&!item.includes('\n')));
      if(key!=null)node.append(make('span','message-field',fieldLabel(key)));
      if(typeof item==='string'&&item&&!code) {
        for(const [index,part]of contentParts(item).entries())node.append(part.kind==='text'?markdown(document,part.value)
          : render(part.value,null,`${location}/block/${index}`,false));
      } else node.append(make('div',code?'message-text message-code':'message-text',item===null?'null':item===''?'(empty text)':String(item)));
      return node;
    }
    const entries=Object.entries(item),array=Array.isArray(item);
    if(!entries.length){node.classList.add('message-empty-record');if(key!=null)node.append(make('span','message-field',fieldLabel(key)));node.append(make('span','message-empty',array?'Empty list':'Empty record'));return node;}
    const children=make('div','message-fields');let loaded=0,more;
    const populate=()=>{
      more?.remove();
      for(const [name,child]of entries.slice(loaded,loaded+50))children.append(render(child,array?(entries.length===1?null:`Item ${Number(name)+1}`):name,`${location}/${encodeURIComponent(name)}`,child!==null&&typeof messageValue(child)==='object'));
      loaded+=50;
      if(loaded<entries.length){more=make('button','message-more',`Show next ${Math.min(50,entries.length-loaded)} items (${entries.length-loaded} remaining)`);more.type='button';more.addEventListener('click',populate);children.append(more);}
    };
    if(fold&&(forceFold||!small(item))) {
      const details=make('details','message-branch'),summary=make('summary');details.dataset.path=location;
      summary.append(make('span','message-field',fieldLabel(key??'Content')));if(array)summary.append(make('span','message-count',`${entries.length} items`));
      details.append(summary,children);details.open=expanded.has(location);if(details.open)populate();
      details.addEventListener('toggle',()=>{if(details.open){expanded.add(location);if(!loaded)populate();}else expanded.delete(location);});
      node.append(details);
    } else {if(key!=null)node.append(make('div','message-group-label',fieldLabel(key)));populate();node.append(children);}
    return node;
  };
  if(table&&value!==null&&typeof value==='object') {
    const wrapper=make('div','message-call'),grid=make('table','message-arguments'),head=make('thead'),headers=make('tr'),body=make('tbody');
    wrapper.append(make('hr'),make('h5','message-tool',label));
    for(const title of ['Argument','Value']){const th=make('th',null,title);th.scope='col';headers.append(th);}head.append(headers);grid.append(head,body);
    for(const [key,item]of Object.entries(value)) {
      const row=make('tr'),name=make('th',null,key),cell=make('td');name.scope='row';
      const content=render(item,null,`${path}/${encodeURIComponent(key)}`,true,false,/^(code|command|script|source|patch|diff|stdout|stderr)$/i.test(key));
      cell.append(content);row.append(name,cell);body.append(row);
    }
    if(!Object.keys(value).length){const row=make('tr'),cell=make('td',null,'No arguments');cell.colSpan=2;row.append(cell);body.append(row);}
    wrapper.append(grid);return wrapper;
  }
  return render(value,label,path,collapsed,collapsed);
}
export function messageHeading(message) {
  if(message.role==='user')return 'Input (User)';
  if(message.role==='toolResult')return `Tool result${message.toolName?' · '+message.toolName:''}`;
  if(message.role==='assistant') {
    const calls=Array.isArray(message.content)?message.content.filter(block=>block?.type==='toolCall').map(block=>block.name??'unnamed tool'):[];
    return calls.length?`Assistant · Tool ${calls.length===1?'call':'calls'}`:'Assistant';
  }
  return {system:'System',context:'Context compacted'}[message.role]??message.role??'Message';
}
export function sourceLabel(source,fallback='Agent session') {
  if(source.title&&!/[\/]|\.json(?:$|\s)/i.test(source.title))return source.title;
  const name=source.memberName??source.participant??source.agentName??source.member??fallback;
  return [name,source.turn==null?null:`Turn ${source.turn}`,source.stage??source.phase].filter(Boolean).join(' · ');
}

/** Lazy DOM tree: large records stay collapsed; text opens in the host console. */
export function jsonTree(document, value, {label='Data', onText=()=>{}, expanded=new Set()} = {}) {
  const make=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!=null)item.textContent=text;return item;};
  const branch=(key,item,path,ancestors)=>{
    const info=jsonSummary(item),row=make('div','tree-row');row.dataset.type=info.type;
    if(item!==null&&typeof item==='object') {
      if(ancestors.includes(item)){row.append(make('span','tree-key',key),make('span','tree-meta','circular reference'));return row;}
      const detail=make('details','tree-branch'),summary=make('summary');
      detail.dataset.path=path;summary.append(make('span','tree-key',key),make('span','tree-type',info.type),make('span','tree-meta',info.preview));
      detail.append(summary);let loaded=false;
      const populate=()=>{
        if(loaded)return;loaded=true;const list=make('div','tree-children');detail.append(list);
        const entries=Object.entries(item);let offset=0;
        const more=()=>{
          for(const [name,child] of entries.slice(offset,offset+50))list.append(branch(Array.isArray(item)?`[${name}]`:name,child,`${path}/${encodeURIComponent(name)}`,[...ancestors,item]));
          offset+=50;
          if(offset<entries.length){const next=make('button','tree-more',`Show next ${Math.min(50,entries.length-offset)} of ${entries.length-offset} remaining`);next.type='button';next.addEventListener('click',()=>{next.remove();more();});list.append(next);}
        };more();
      };
      detail.addEventListener('toggle',()=>{if(detail.open){expanded.add(path);populate();}else expanded.delete(path);});
      if(expanded.has(path)){detail.open=true;populate();}
      return detail;
    }
    row.append(make('span','tree-key',key),make('span','tree-type',info.type),make('span','tree-value',info.preview));
    if(info.long){const button=make('button','tree-text','Read text');button.type='button';button.addEventListener('click',()=>onText({title:key,text:item,path}));row.append(button);}
    return row;
  };
  const tree=make('div','json-tree');tree.append(branch(label,value,'$',[]));return tree;
}

export function startDashboard(document, window) {
  const $ = selector => document.querySelector(selector);
  const state = {runs: [], runId: null, jobId: null, generation: 0, frozen: false, pending: false,
    refreshing: false, stopped: false, renderer: null, rendererURL: null, rendererKey: null,
    renderEpoch: 0, frames: [], world: null, replay: null, event: null, control: {}, timer: null,
    job:null,member:null,memberEpoch:0,consoleTab:'transcript',consoleSource:'job',consoleText:{},follow:true,
    inspection:null,expanded:new Set(['$']),overviewExpanded:false,frameSignature:null,
    systemFilter:new URL(window.location.href).searchParams.get('system')??'',senateParticipant:null,
    transcriptPayload:null,sourceContext:null,sourceId:null,sourceEpoch:0,sourcePending:null,sources:[],outputRecords:[],transcriptMessages:null,messagesNotice:''};
  const runRows = new Map(), jobRows = new Map(), eventRows = new Map(), outputRows = new Map(), messageRows = new Map();
  const workflowViewport = mountWorkflowViewport($('#workflow-viewport'), {
    zoomIn: $('#workflow-zoom-in'), zoomOut: $('#workflow-zoom-out'),
    fitButton: $('#workflow-fit'), level: $('#workflow-zoom-level'),
  });
  const api = async (path, options) => {
    const response = await window.fetch(path, options);
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? `Request failed (${response.status})`);
    return value;
  };
  const text = (node, value) => { const next = value == null ? '' : String(value); if (node.textContent !== next) node.textContent = next; };
  const valueText = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const friendly = value => String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) text(node, content);
    return node;
  };
  function changed(node, data, build) {
    const signature = JSON.stringify(data);
    if (node._signature !== signature) { node._signature = signature; node.replaceChildren(...build()); }
  }
  function fact(label, value, identifier = false) {
    const item = element('div');
    item.append(element('dt', null, label), element('dd', identifier ? 'identifier' : null, value ?? '—'));
    const button=element('button','fact-inspect');button.type='button';button.setAttribute('aria-label',`Inspect ${label}`);
    button.append(...item.childNodes);item.append(button);
    button.addEventListener('click',()=>inspect({title:label,description:'Recorded value for the selected execution or world state.',data:{value}}));
    return item;
  }
  function showError(error) { $('#error').hidden = !error; text($('#error'), error?.message ?? ''); }
  function tree(value,label='Data') { return jsonTree(document,value,{label,onText:showText,expanded:state.expanded}); }
  function inspect(selection={}) {
    const title=selection.title??'Selected item';
    if(state.inspection?.title!==title)state.expanded=new Set(['$']);
    state.inspection=selection;
    text($('#inspector-title'),title);
    changed($('#inspector-description'),[title,selection.description],()=>[messageRecord(document,selection.description??'',{expanded:state.expanded,path:'description'})]);
    changed($('#inspector-tree'),[title,selection.data],()=>[tree(selection.data??{},'Details')]);
    if(selection.transcript) {
      state.consoleSource='selection';state.member=null;$('#console-member').value='';
      const transcript=typeof selection.transcript==='string'?{text:selection.transcript}:selection.transcript;
      text($('#console-context'),transcript.title??title);setConsoleText('transcript',transcript.text??'');showConsole('transcript');
    }
  }
  function inspectWorker() {
    if(!state.job)return;
    const {job,worker,kind,data}=state.job;
    inspect({title:job.name??job.type??'Worker',description:`${friendly(kind)} worker · ${friendly(job.status)}.`,
      owner:'job',data:{kind,status:job.status,activity:messageValue(job.detail??job.activity??null),id:job.id,definition:worker,record:data}});
  }
  function showText({title,text:content}) {
    text($('#text-title'),title??'Selected text');$('#tab-text').hidden=false;
    setConsoleText('text',content);showConsole('text',{focus:true});
  }
  function consoleNode(tab=state.consoleTab) {return $({transcript:'#transcript',output:'#output',text:'#long-text',events:'#events'}[tab]);}
  function scrollConsole(node,top) {node.scrollTop=top;node._programScrollTop=node.scrollTop;}
  function setConsoleText(tab,value) {
    if(tab==='transcript'){state.transcriptMessages=null;messageRows.clear();}
    const content=Array.isArray(value)?value.join('\n'):String(value??'');state.consoleText[tab]=content;
    renderConsoleText(tab);
  }
  function renderConsoleText(tab=state.consoleTab) {
    const query=$('#console-search').value.toLocaleLowerCase(),node=consoleNode(tab);
    if(tab==='transcript'&&state.transcriptMessages!==null){renderMessages();return;}
    if(tab==='output') {renderOutput();return;}
    if(tab==='events') {
      let count=0;
      for(const row of eventRows.values()){row.hidden=Boolean(query)&&!eventDescription(row._event).toLocaleLowerCase().includes(query);if(!row.hidden)count++;}
      text($('#console-matches'),query?`${count} events`:'');return;
    }
    const content=state.consoleText[tab]??'',signature=JSON.stringify([content,tab===state.consoleTab?query:'']);
    if(node._signature!==signature) {
      const offset=node.scrollTop;node._signature=signature;node.replaceChildren();
      if(tab===state.consoleTab&&query) {
        let start=0,index,count=0;const lower=content.toLocaleLowerCase();
        while((index=lower.indexOf(query,start))>=0&&count<1000) {
          node.append(document.createTextNode(content.slice(start,index)),element('mark',null,content.slice(index,index+query.length)));
          start=index+query.length;count++;
        }
        node.append(document.createTextNode(content.slice(start)));text($('#console-matches'),`${count}${count===1000?'+':''} matches`);
      } else {text(node,content||'No text has been recorded yet.');if(tab===state.consoleTab)text($('#console-matches'),'');}
      scrollConsole(node,state.follow&&tab===state.consoleTab&&!query?node.scrollHeight:offset);
    }
  }
  function showConsole(tab,{focus=false}={}) {
    state.consoleTab=tab;
    for(const button of document.querySelectorAll('[data-console]')) {
      const selected=button.dataset.console===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      $('#'+button.getAttribute('aria-controls')).hidden=!selected;
    }
    renderConsoleText();
    if(state.follow&&!$('#console-search').value)scrollConsole(consoleNode(),consoleNode().scrollHeight);
    if(focus)$('#console').scrollIntoView({block:'nearest'});
  }
  function conversation(payload) {
    if(payload.job&&kindOf(payload)==='program')return 'This program job has no model-session transcript. Read its execution evidence in Output.';
    return payload.transcript?.text??'No saved agent messages are available for this selection.';
  }
  function setMessages(transcript,fallback) {
    if(!Array.isArray(transcript?.messages)){setConsoleText('transcript',fallback??transcript?.text??'');return;}
    state.transcriptMessages=transcript.messages;
    state.messagesNotice=transcript.messagesNotice??(!transcript.messages.length?transcript.text??'No saved messages in this selection.':'');
    renderMessages();
  }
  function renderMessages() {
    const parent=$('#transcript'),offset=parent.scrollTop,query=state.consoleTab==='transcript'?$('#console-search').value.toLocaleLowerCase():'';
    parent._signature=undefined;
    const messages=state.transcriptMessages??[],signature=JSON.stringify([messages,state.messagesNotice]),updated=parent._messagesSignature!==signature;parent._messagesSignature=signature;
    for(const child of [...parent.childNodes])if(child.nodeType!==1||(!child.classList.contains('conversation-message')&&!child.classList.contains('conversation-notice')))child.remove();
    const keys=[];
    for(const [index,message]of messages.entries()) {
      const id=String(message.id??index);keys.push(id);let row=messageRows.get(id);
      if(!row){row=element('article','conversation-message');row.dataset.message=id;row._trees=new Map();row._expanded=new Set();messageRows.set(id,row);}
      const next=JSON.stringify(message);
      if(row._messageSignature!==next) {
        row._messageSignature=next;row._searchText=next.toLocaleLowerCase();
        const role=message.role==='toolResult'?`Tool result · ${message.toolName??'tool'}`:friendly(message.role??'message');
        const context=[message.memberName??message.participant??message.agentName??message.member,message.turn==null?null:`turn ${message.turn}`,message.phase??message.participant].filter(Boolean).join(' · ');
        const content=messageDisplay(message);row._searchText=[context,content].join('\n').toLocaleLowerCase();
        row.replaceChildren();
        const heading=element('header','message-heading');heading.append(element('strong',null,messageHeading(message)));
        if(context)heading.append(element('span','message-context',context));row.append(heading);
        const body=element('div','message-body');
        for(const [part,section]of messageSections(message).entries())body.append(messageRecord(document,section.value,{label:section.label,collapsed:section.collapsed,table:section.kind==='toolCall',expanded:row._expanded,path:`part/${part}`}));
        if(!body.childNodes.length)body.append(element('p','message-text','No content blocks in this saved message.'));
        row.append(body);
        const plain=element('details','message-plain'),summary=element('summary',null,'Plain text');
        plain.open=row._expanded.has('plain');plain.append(summary,element('p','message-text',content));
        plain.addEventListener('toggle',()=>{if(plain.open)row._expanded.add('plain');else row._expanded.delete('plain');});
        row.append(plain);
        const details=element('button','message-details','Details');details.type='button';
        details.addEventListener('click',()=>inspect({title:`${role}${context?' · '+context:''}`,description:'Original saved message and source information.',data:message}));
        row.append(details);
      }
      row.hidden=Boolean(query)&&!row._searchText.includes(query);row.dataset.searchMatch=String(Boolean(query)&&!row.hidden);
    }
    reconcile(parent,messageRows,keys);
    let notice=parent.querySelector('.conversation-notice');
    if(state.messagesNotice){if(!notice){notice=element('p','conversation-notice');parent.prepend(notice);}text(notice,state.messagesNotice);}else notice?.remove();
    if(state.consoleTab==='transcript')text($('#console-matches'),query?`${[...messageRows.values()].filter(row=>!row.hidden).length} messages`:'');
    if(updated)scrollConsole(parent,state.follow&&state.consoleTab==='transcript'&&!query?parent.scrollHeight:offset);
  }
  function setOutput(payload) {state.outputRecords=outputRecords(payload);renderOutput();}
  function renderOutput() {
    const parent=$('#output'),offset=parent.scrollTop,query=state.consoleTab==='output'?$('#console-search').value.toLocaleLowerCase():'';
    const keys=[],signature=JSON.stringify(state.outputRecords),updated=parent._recordsSignature!==signature;parent._recordsSignature=signature;
    for(const record of state.outputRecords) {
      const id=String(record.id);keys.push(id);
      let row=outputRows.get(id);
      if(!row) {
        row=element('details','output-record');row.dataset.record=id;row._expanded=new Set();
        row.append(element('summary'),element('div','output-record-body'));outputRows.set(id,row);
        row.addEventListener('toggle',()=>{if(row.open)populateOutput(row);});
      }
      row._record=record;
      text(row.firstChild,record.title??record.type??id);
      const next=JSON.stringify(record);
      if(row._recordSignature!==next){row._recordSignature=next;row._searchText=next.toLocaleLowerCase();if(row.open)populateOutput(row);}
      row.hidden=Boolean(query)&&!row._searchText.includes(query);row.dataset.searchMatch=String(Boolean(query)&&!row.hidden);
    }
    reconcile(parent,outputRows,keys);
    if(!keys.length) {
      if(!parent.querySelector('.output-empty'))parent.append(element('p','output-empty','No saved output is available for this selection.'));
    } else parent.querySelector('.output-empty')?.remove();
    if(state.consoleTab==='output')text($('#console-matches'),query?`${[...outputRows.values()].filter(row=>!row.hidden).length} records`:'');
    if(updated)scrollConsole(parent,state.follow&&state.consoleTab==='output'&&!query?parent.scrollHeight:offset);
  }
  function populateOutput(row) {
    if(row._bodySignature===row._recordSignature)return;
    row._bodySignature=row._recordSignature;
    const record=row._record,body=row.lastChild;body.replaceChildren();
    if(record.data!==undefined)body.append(messageRecord(document,record.data,{expanded:row._expanded}));
    if(record.text) {
      body.append(messageRecord(document,String(record.text),{expanded:row._expanded}));
    }
    const plain=element('details','message-plain'),summary=element('summary',null,'Plain text');
    plain.append(summary,element('p','message-text message-code',record.text??JSON.stringify(record.data,null,2)));body.append(plain);
  }
  function resetSource() {state.sourceId=null;state.sourceEpoch++;state.sourcePending=null;state.sourceContext=null;}
  function setTranscript(payload) {
    const context=[state.runId,state.jobId,state.member??state.senateParticipant??''].join('/');
    if(state.sourceContext!==context){resetSource();state.sourceContext=context;}
    state.transcriptPayload=payload;state.sources=payload.transcript?.sources??[];
    const select=$('#transcript-source'),options=[...state.sources];
    if(state.sourceId&&!options.some(source=>source.id===state.sourceId))options.push({id:state.sourceId,title:'Selected saved source (not in current index)'});
    changed(select,options.map(source=>[source.id,source.title,source.memberName,source.turn,source.stage]),()=>[
      Object.assign(element('option',null,state.member?'Member aggregate':'Whole execution'),{value:''}),
      ...options.map(source=>Object.assign(element('option',null,sourceLabel(source,payload.job?.name??payload.name??'Agent session')),{value:source.id}))]);
    select.value=state.sourceId??'';select.disabled=!options.length;
    if(state.sourceId){loadSource(state.sourceId,{refresh:true});return;}
    text($('#source-path'),state.sources.length?`${state.sources.length} saved sessions · aggregate conversation`:'Aggregate conversation · no individual saved sources in the current index');
    text($('#source-feedback'),payload.transcript?.sourcesNotice??'');
    text($('#transcript-title'),payload.job&&kindOf(payload)==='program'?'Agent conversation':payload.transcript?.title??'Transcript');
    setMessages(payload.transcript,conversation(payload));
  }
  async function loadSource(id,{refresh=false}={}) {
    if(!refresh){state.sourceId=id||null;state.sourceEpoch++;state.sourcePending=null;}
    if(!id){setTranscript(state.transcriptPayload??{});return;}
    const generation=state.generation,epoch=state.sourceEpoch,key=[generation,epoch,id].join('/');
    if(state.sourcePending===key)return;
    state.sourcePending=key;
    const source=state.sources.find(source=>source.id===id);
    if(source?.path)text($('#source-path'),source.path);
    if(!refresh){text($('#source-feedback'),'Loading saved source…');setConsoleText('transcript','Loading saved agent messages…');}
    try {
      const payload=await api(`/api/runs/${encodeURIComponent(state.runId)}/jobs/${encodeURIComponent(state.jobId)}/transcripts/${encodeURIComponent(id)}`);
      if(generation!==state.generation||epoch!==state.sourceEpoch||id!==state.sourceId)return;
      text($('#source-path'),payload.path??source?.path??id);text($('#source-feedback'),'');
      text($('#transcript-title'),payload.transcript?.title??payload.title??'Saved conversation');
      setMessages(payload.transcript,'No saved messages are present in this source.');
    } catch(error) {
      if(generation===state.generation&&epoch===state.sourceEpoch)text($('#source-feedback'),`Cannot read the selected saved source: ${error.message}. Retrying on refresh.`);
    } finally {if(state.sourcePending===key)state.sourcePending=null;}
  }
  async function selectMember(id,{focus=false,refresh=false}={}) {
    const generation=state.generation,epoch=refresh?state.memberEpoch:++state.memberEpoch;
    if(!refresh)resetSource();
    state.member=id||null;state.consoleSource=id?'member':'job';$('#console-member').value=id??'';
    if(!id) {
      if(state.job){setTranscript(state.job);setOutput(state.job);text($('#console-context'),`${state.job.job.name??state.job.job.type} · whole execution`);inspectWorker();}
      if(!refresh)showConsole('transcript',{focus});return null;
    }
    if(!refresh){text($('#console-context'),`${id} · loading saved history`);setConsoleText('transcript','Loading member transcript…');showConsole('transcript',{focus});}
    try {
      const member=await api(`/api/runs/${encodeURIComponent(state.runId)}/jobs/${encodeURIComponent(state.jobId)}/members/${encodeURIComponent(id)}`);
      if(generation!==state.generation||epoch!==state.memberEpoch||state.member!==id)return null;
      text($('#console-context'),`${member.name??id} · latest saved history${member.turn==null?'':` · turn ${member.turn}`}`);
      setTranscript(member);setOutput(member);
      if(!refresh||state.inspection?.owner==='member')inspect({title:member.name??id,owner:'member',description:`Swarm member · ${friendly(member.status??'recorded')}. ${member.hasConversation===false?'No saved agent messages were found in the available evidence for this member. Program evidence is available in Output.':'Transcript shows saved model messages and tool calls.'}`,
        data:{id:member.id??id,status:member.status,turn:member.turn,decisions:member.decisions,evidence:member.data}});
      return member;
    }catch(error){if(generation===state.generation&&epoch===state.memberEpoch)text($('#member-feedback'),`Cannot refresh selected member: ${error.message}. Retrying on refresh.`);return null;}
  }
  async function loadMembers(generation) {
    try {
      const payload=await api(`/api/runs/${encodeURIComponent(state.runId)}/jobs/${encodeURIComponent(state.jobId)}/members`);
      if(generation!==state.generation)return;
      text($('#member-feedback'),'');
      const members=payload.members??[],select=$('#console-member');
      changed(select,members.map(member=>[member.id,member.name]),()=>[
        Object.assign(element('option',null,'Whole swarm'),{value:''}),
        ...members.map(member=>Object.assign(element('option',null,member.name??member.id),{value:member.id}))]);
      select.value=state.member??'';
      if(state.member)await selectMember(state.member,{focus:false,refresh:true});
    }catch(error){if(generation===state.generation)text($('#member-feedback'),`Member list unavailable: ${error.message}. Retrying on the next refresh.`);}
  }
  function updateHash() {
    const query = new URLSearchParams();
    if (state.runId) query.set('run', state.runId);
    if (state.jobId) query.set('job', state.jobId);
    const url=new URL(window.location.href);url.hash=query.toString();
    window.history.replaceState(null, '', url);
  }
  function disposeWorld() {
    state.renderEpoch++;
    try { state.renderer?.dispose(); } catch (error) { showError(error); }
    state.renderer = null; state.rendererURL = null; state.rendererKey = null;
    state.world = null; state.frames = []; state.replay = null; state.control = {};state.frameSignature=null;
    $('#world').replaceChildren(); $('#world-section').hidden = true;
    $('#execution-controls').hidden = true;
  }
  function selectRun(id, jobId = null) {
    state.senateParticipant=null;
    resetSource();state.generation++; state.runId = id; state.jobId = jobId; state.event = null;
    state.job=null;state.inspection=null;state.member=null;state.memberEpoch++;state.consoleSource='job';state.overviewExpanded=false;
    disposeWorld(); updateHash();
    $('#detail').hidden = !id;
    $('main').classList.toggle('has-selection',Boolean(id));$('#inspector').hidden=!id;$('#toggle-inspector').hidden=!id;
    $('#overview').classList.toggle('overview-compact',Boolean(id));$('#overview-toggle').hidden=!id;
    if (!id) { workflowViewport.clear(); renderRuns(); return; }
    text($('#run-title'), 'Loading run'); text($('#run-request'), '');
    $('#jobs').replaceChildren(); jobRows.clear(); $('#typed-view').replaceChildren(); $('#typed-view')._signature = undefined;
    setConsoleText('transcript','Loading worker transcript…');showConsole('transcript');$('#result-section').hidden=true;
    refresh(true);
  }
  function selectJob(id) {
    state.senateParticipant=null;
    if (id === state.jobId) {selectMember(null);return;}
    resetSource();state.generation++; state.jobId = id; disposeWorld(); updateHash();
    state.job=null;state.inspection=null;state.member=null;state.memberEpoch++;state.consoleSource='job';
    $('#typed-view').replaceChildren(); $('#typed-view')._signature = undefined;
    setConsoleText('transcript','Loading worker transcript…');showConsole('transcript');
    text($('#control-feedback'), ''); refresh(true);
  }
  function reconcile(parent, rows, keys) {
    const wanted = new Set(keys);
    for (const [key, row] of rows) if (!wanted.has(key)) { row.remove(); rows.delete(key); }
    let position = parent.firstElementChild;
    for (const key of keys) {
      const row = rows.get(key);
      if (row !== position) parent.insertBefore(row, position);
      position = row.nextElementSibling;
    }
  }
  function renderRuns() {
    const filter = {system: $('#system-filter').value, activity: $('#activity-filter').value, kind: $('#kind-filter').value, search: $('#search').value};
    const selected = filteredRuns(state.runs, filter);
    for (const run of selected) {
      let row = runRows.get(run.id);
      if (!row) {
        row = element('tr'); row.dataset.run = run.id;
        const title = element('button', 'run-select'); title.type = 'button';
        title.addEventListener('click', () => selectRun(run.id));
        const first = element('td'); first.append(title, element('span', 'run-caption'));
        const scope = element('td'); scope.append(element('div'), element('div', 'run-environment'));
        const work = element('td'); work.append(element('div', 'work-type'), element('div', 'quiet'));
        const status = element('td'); status.append(element('span', 'state-label'), element('span', 'run-caption'));
        row.append(first, scope, work, status, element('td', 'quiet'));
        runRows.set(run.id, row);
      }
      row.setAttribute('aria-selected', String(run.id === state.runId));
      const cells = row.children;
      text(cells[0].children[0], run.name ?? run.worker_name ?? run.id);
      text(cells[0].children[1], run.request ?? run.id); cells[0].children[1].title = run.request ?? run.id;
      text(cells[1].children[0], run.system ?? 'Local'); text(cells[1].children[1], run.environment ?? '—');
      text(cells[2].children[0], run.kind ?? run.worker_kind ?? (run.workflow ? 'workflow' : 'program'));
      text(cells[2].children[1], `${run.jobs?.active ?? 0} active / ${run.jobs?.total ?? 0} jobs`);
      text(cells[3].children[0], friendly(run.status ?? 'unknown'));
      text(cells[3].children[1], run.activity ?? run.detail ?? run.error ?? '');
      text(cells[4], run.elapsed ?? '—');
    }
    reconcile($('#runs'), runRows, selected.map(run => run.id));
    $('#empty-runs').hidden = selected.length > 0;
    text($('#visible-count'), `${selected.length} of ${state.runs.length} runs`);
  }
  function renderOverview(payload) {
    state.runs = Array.isArray(payload.runs) ? payload.runs : [];
    const scope = typeof payload.scope === 'string' ? payload.scope : payload.scope?.name ?? payload.scope?.root ?? 'Local systems';
    text($('#scope'), scope);
    const systems = [...new Set(state.runs.map(run => run.system).filter(Boolean))].sort();
    const select = $('#system-filter'), previous = state.systemFilter;
    changed(select, systems, () => ['', ...systems].map(system => {
      const option = element('option', null, system || 'All systems'); option.value = system; return option;
    }));
    select.value = systems.includes(previous) ? previous : '';
    const working = state.runs.filter(run => active(run.status)).length;
    changed($('#totals'), [systems.length, working, state.runs.length], () => {
      const line = element('span');
      line.append(element('strong', null, working), document.createTextNode(` active · ${state.runs.length - working} saved`),
        element('br'), document.createTextNode(`${systems.length} ${systems.length === 1 ? 'system' : 'systems'} in this scope`));
      return [line];
    });
    renderRuns();
  }
  function renderRun(payload) {
    const run = payload.run ?? payload;
    $('main').classList.add('has-selection');$('#inspector').hidden=false;$('#toggle-inspector').hidden=false;
    text($('#run-title'), run.name ?? run.worker_name ?? run.id);
    text($('#run-request'), run.request ?? run.input?.request ?? '');
    changed($('#run-facts'), [run.system, run.environment, run.status, run.elapsed, run.id], () => [
      fact('System', run.system ?? 'Local'), fact('Environment', run.environment, true),
      fact('Status', friendly(run.status)), fact('Elapsed', run.elapsed), fact('Run', run.id, true)]);
    $('#detail').hidden = false;
    $('#overview-toggle').hidden=false;$('#overview').classList.toggle('overview-compact',!state.overviewExpanded);
    const jobs = payload.jobs ?? [];
    text($('#job-count'), `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} in this run`);
    for (const job of jobs) {
      let row = jobRows.get(job.id);
      if (!row) {
        row = element('button', 'job-option'); row.type = 'button'; row.dataset.job = job.id;
        row.append(element('strong'), element('span', 'work-type'), element('span', 'quiet'));
        row.addEventListener('click', () => selectJob(job.id)); jobRows.set(job.id, row);
      }
      row.setAttribute('aria-current', String(job.id === state.jobId));
      text(row.children[0], job.name ?? job.type ?? job.id);
      text(row.children[1], job.kind ?? job.type ?? 'program');
      text(row.children[2], `${friendly(job.status ?? 'unknown')} · ${job.elapsed ?? '—'}`);
    }
    reconcile($('#jobs'), jobRows, jobs.map(job => job.id));
    renderWorkflow(payload.workflow, jobs);
    if(kindOf(jobs.find(job=>job.id===state.jobId)??{})!=='swarm')renderEvents(payload.events??[]);
  }
  function renderWorkflow(workflow, jobs) {
    const nodes = workflow?.nodes ?? [];
    $('#workflow-section').hidden = !nodes.length;
    if (!nodes.length) { $('#workflow').replaceChildren(); $('#workflow')._signature = undefined; workflowViewport.clear(); return; }
    changed($('#workflow'), [workflow, jobs.map(job => [job.id, job.status,job.kind]), state.jobId], () => {
      const layout = workflowLayout(nodes, [...(workflow.edges ?? []),...(workflow.attachments??[])]);
      const svg = (tag, attributes = {}, content) => {
        const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        if (content != null) node.textContent = content;
        return node;
      };
      const root = svg('svg', {viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width,
        height: layout.height, role: 'group', 'aria-label': 'Workflow connections and task states'});
      for (const edge of layout.edges) {
        const line=svg('polyline',{points:edge.points.map(point=>`${point.x},${point.y}`).join(' '),fill:'none',stroke:theme.rail,'stroke-width':1.5,
          ...(edge.kind==='attachment'?{'stroke-dasharray':'3 4'}:{}),
          'data-edge':edge.id??`${edge.source}/${edge.target}`,'data-source':edge.source,'data-target':edge.target});
        line.append(svg('title',{},edge.kind==='attachment'?`Boundary event ${edge.target} attached to ${edge.source}`:edge.returning?edge.label:`${edge.source} to ${edge.target}`));root.append(line);
        if(edge.width)root.append(svg('text',{x:edge.x,y:edge.y-6,fill:theme.inchiostro,'font-size':11,'text-anchor':'middle'},edge.name??friendly(edge.id??'Branch')));
        if(edge.returning)root.append(svg('text',{x:edge.labelX,y:edge.labelY,fill:theme.inchiostro,'font-size':11,'text-anchor':'end'},edge.label));
      }
      for (const node of layout.nodes) {
        const job = workflowJob(node,jobs);
        const work=workflowKind(node,job);
        const item = svg('g', {transform: `translate(${node.x},${node.y})`});
        item.append(svg('rect',{x:-100,y:-32,width:200,height:104,class:'workflow-node-hit'}));
        const name = node.name ?? node.id, label = `${name}: ${friendly(job?.status ?? node.type ?? 'step')}`;
        item.append(svg('title', {}, label));
        const type = String(node.type ?? '').toLowerCase();
        if (type.includes('event')) item.append(svg('line', {x1: 0, x2: 0, y1: -12, y2: 8, stroke: theme.inchiostro, 'stroke-width': 2}));
        else item.append(svg('path', {...markAttributes(theme,type.includes('gateway')?{x:-11,y:-6,width:22,height:19,gateway:true}:{x:-12,y:-21}),
          class:'work-mark','data-kind':type.includes('gateway')?'gateway':work,fill:workColor(type.includes('gateway')?'gateway':work)}));
        const lines=workflowLabel(name);
        for(const [index,line]of lines.entries())item.append(svg('text', {x: 0, y: 23+index*15, fill: theme.inchiostro, 'font-size': 12, 'font-weight': 700, 'text-anchor':'middle'},line));
        const caption=23+lines.length*15;
        item.append(svg('text', {x: 0, y: caption+3, fill: theme.inchiostro, 'font-size': 11, 'text-anchor':'middle'}, type.includes('task')?`${work} · ${friendly(job?.status??'Not started')}`:friendly(node.type??'step')));
        item.setAttribute('role', 'button');item.setAttribute('tabindex', '0');item.setAttribute('aria-label',label);item.dataset.node=node.id;item.style.cursor='pointer';
        const choose=()=>{
          if(job)selectJob(job.id);
          inspect({title:name,description:`${describeWorkflowNode(node,layout.edges)}${!job&&type.includes('task')?' This task has not started; its execution output will appear when it runs.':''}`,data:{type:node.type,id:node.id,worker:node.workerType??job?.type,
            scope:node.scope,attachedToRef:node.attachedToRef,calledElement:node.calledElement,eventDefinitions:node.eventDefinitions,
            execution:job?{status:job.status,activity:job.detail,job:job.id}:null,
            incoming:layout.edges.filter(edge=>edge.target===node.id),outgoing:layout.edges.filter(edge=>edge.source===node.id),defaultFlow:node.defaultFlow??null}});
        };
        item.addEventListener('click',choose);
        item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});
        if(job?.id===state.jobId)item.append(svg('line',{x1:-42,x2:42,y1:caption+11,y2:caption+11,stroke:theme.inchiostro,'stroke-width':2}));
        root.append(item);
      }
      return [root];
    });
    const root = $('#workflow svg');
    workflowViewport.update(root, {width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height'))},
      JSON.stringify([state.runId, workflow]));
  }
  function section(title, body) {
    const item = element('section', 'typed-section'); item.append(element('h4', null, title), body); return item;
  }
  function reportFields(report) {
    return jsonTree(document,report,{label:'Result fields',onText:showText});
  }
  function phases(sessions, senate) {
    const wrapper = element('div', 'table-scroll'), table = element('table', 'phase-table');
    const head = element('thead'), labels = element('tr');
    for (const label of senate ? ['Round / speaker', 'Phase', 'Status', 'Result'] : ['Attempt', 'Phase', 'Status', 'Result']) labels.append(element('th', null, label));
    head.append(labels); table.append(head); const body = element('tbody');
    for (const session of sessions) {
      const row = element('tr');
      const result=element('td'),summary=session.result?.final??session.error;
      if(summary){const button=element('button','text-link',String(summary).slice(0,90)+(summary.length>90?'…':''));button.type='button';button.addEventListener('click',()=>{inspect({title:`${session.participant??'Attempt '+session.attempt} · ${session.phase}`,description:'Saved phase result and evidence.',data:session});showText({title:`${session.phase} result`,text:summary});});result.append(button);}
      row.append(element('td', 'phase-person', senate ? `${session.round ?? '—'} · ${session.participant ?? 'Participant'}` : session.attempt ?? '—'),
        element('td', null, friendly(session.phase)), element('td', null, friendly(session.status)),result);
      body.append(row);
    }
    table.append(body); wrapper.append(table); return wrapper;
  }
  function typedView(kind, data, worker) {
    const result = [], checkpoint = data[kind] ?? {};
    if (kind === 'goal') {
      if (checkpoint.goal) {
        const content = element('p', 'text-block goal-content', checkpoint.goal);
        content.tabIndex = 0; content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Goal');
        result.push(section('Goal', content));
      }
      if (checkpoint.sessions?.length) result.push(section('Attempts and verification', phases(checkpoint.sessions, false)));
    } else if (kind === 'senate') {
      result.push(section('Topic', element('p', 'text-block senate-topic', checkpoint.topic??'')));
      result.push(section('Senate',element('div','senate-mount')));
      result.push(section('Discussion and assessment',element('div','senate-phases')));
    } else if (kind === 'program') {
      const command = data.command ?? worker?.command ?? worker?.config?.command;
      if (command) result.push(section('Command', element('pre', null, Array.isArray(command) ? command.join(' ') : valueText(command))));
    } else if(kind==='human') {
      const request=element('div','human-request');
      request.append(messageRecord(document,data.input??{}));
      request.append(element('p','quiet','Answer this request through asys-human-prompt. Its decision becomes the job result and controls the workflow branch.'));
      result.push(section('Human request',request));
    }
    return result;
  }
  function renderJob(payload) {
    const job = payload.job ?? {}, kind = kindOf(payload), data = payload.data ?? {};
    const selectionChanged=state.job?.job?.id!==job.id;
    state.job=payload;
    text($('#job-title'), job.name ?? job.type ?? job.id); text($('#job-kind'), kind);
    text($('#job-status'), friendly(job.status ?? 'unknown'));
    text($('#open-transcript'),kind==='program'?'Open output':'Open transcript');
    const activity=messageValue(job.detail??job.activity??job.error??'');
    changed($('#job-activity'),[job.id,activity],()=>[messageRecord(document,activity,
      activity!==null&&typeof activity==='object'?{label:'Activity',collapsed:true}:{})]);
    const goalScroll = selectionChanged ? 0 : $('.goal-content')?.scrollTop ?? 0;
    changed($('#typed-view'), kind==='senate'?[kind,payload.worker]:[kind, data.goal, data.senate, data.result, data.command, data.input, data.swarm?.evaluation, payload.worker],
      () => typedView(kind, data, payload.worker));
    if ($('.goal-content')) $('.goal-content').scrollTop = goalScroll;
    if(kind==='senate') {
      text($('.senate-topic'),data.senate?.topic??'');
      const mount=$('.senate-mount');mount._view??=mountSenate(mount,{onSelect:selectSenateParticipant});
      mount._view.update(data.senate??{},payload.worker?.config??{},state.senateParticipant);
      changed($('.senate-phases'),data.senate?.sessions,()=>[phases(data.senate?.sessions??[],true)]);
    }
    if(!state.member&&state.consoleSource==='job') {
      const person=kind==='senate'&&senateParticipants(data.senate,payload.worker?.config).find(person=>person.name===state.senateParticipant);
      text($('#console-context'),person?`${person.name} · ${person.role}`:`${job.name??job.type??job.id} · ${kind==='swarm'?'whole swarm':'execution transcript'}`);
      setTranscript(senateTranscript(payload));
    }
    if(!state.member)setOutput(payload);
    if(selectionChanged&&kind==='program')showConsole('output');
    $('#transcript').classList.toggle('program-log', kind === 'program');
    if(!state.inspection||state.inspection.owner==='job')inspectWorker();
    $('#member-label').hidden=kind!=='swarm';
    const result=data.result??data.senate?.decision??data.goal?.result;
    const summary=data.swarm?.evaluation?.summary??result?.final??(typeof result==='string'?result:null);
    $('#result-section').hidden=!result&&!summary;
    changed($('#result'),[result,summary],()=>{
      const items=[];
      if(summary){items.push(element('p','result-summary',summary.length>900?summary.slice(0,900)+'…':summary));if(summary.length>900){const read=element('button','text-link','Read complete result');read.type='button';read.addEventListener('click',()=>showText({title:'Final result',text:summary}));items.push(read);}}
      if(result)items.push(reportFields(result));return items;
    });
    if (kind !== 'swarm') {
      $('#world-section').hidden = true; state.control = payload.control ?? {}; controls();
    }
    text(document.querySelector('[data-control=cancel]'), kind === 'swarm' ? 'Cancel execution' : 'Cancel job');
  }
  function senateTranscript(payload) {
    if(payload.kind!=='senate'||!state.senateParticipant)return payload;
    const name=state.senateParticipant,transcript=payload.transcript??{};
    return {...payload,transcript:{...transcript,title:`${name} · saved conversation`,
      messages:(transcript.messages??[]).filter(message=>message.participant===name),
      sources:(transcript.sources??[]).filter(source=>source.participant===name)}};
  }
  function selectSenateParticipant(person) {
    state.senateParticipant=person?.name??null;resetSource();
    setTranscript(senateTranscript(state.job));showConsole('transcript');
    $('.senate-mount')._view.update(state.job.data.senate??{},state.job.worker?.config??{},state.senateParticipant);
    text($('#console-context'),person?`${person.name} · ${person.role}`:'Whole Senate');
    if(person)inspect({title:person.name,owner:'participant',description:`${person.role} · ${person.status}. ${person.prompt??''}`,data:{role:person.role,model:person.model,contributions:person.sessions}});
    else inspectWorker();
  }
  function renderEvents(events) {
    const node=$('#events'),offset=node.scrollTop,signature=JSON.stringify(events.slice(-100));
    const updated=node._eventsSignature!==signature;node._eventsSignature=signature;
    const rows = events.slice(-100).map((event, index) => ({...event, _key: String(event.sequence ?? event.id ?? `${event.time}-${event.type}-${index}`)}));
    for (const event of rows) {
      let row = eventRows.get(event._key);
      if (!row) {
        row = element('li'); const button = element('button'); button.type = 'button';
        button.append(element('span', 'event-sequence'), element('span'));
        button.addEventListener('click', () => {
          state.event = row._event._key; renderEvent(row._event);
          for (const candidate of eventRows.values()) candidate.firstChild.setAttribute('aria-pressed', String(candidate._event._key === state.event));
        }); row.append(button); eventRows.set(event._key, row);
      }
      row._event = event;
      row.firstChild.setAttribute('aria-pressed', String(event._key === state.event));
      text(row.firstChild.children[0], event.sequence == null ? event.time?.slice(11, 19) ?? '' : `#${event.sequence}`);
      text(row.firstChild.children[1], eventDescription(event));
    }
    reconcile($('#events'), eventRows, rows.map(event => event._key));
    if(state.consoleTab==='events')renderConsoleText('events');
    if(updated)scrollConsole(node,state.follow&&state.consoleTab==='events'&&!$('#console-search').value?node.scrollHeight:offset);
  }
  function renderEvent(event) {
    const {_key, ...record} = event;
    inspect({title:eventDescription(event),description:`Saved execution event${event.time?' · '+event.time:''}. Select fields below for the supporting record.`,data:record});
  }
  function controls() {
    let visible = false;
    for (const button of document.querySelectorAll('[data-control]')) {
      const allowed = state.control[button.dataset.control] === true;
      button.hidden = !allowed; button.disabled = state.frozen || state.replay != null;
      visible ||= allowed;
    }
    $('#execution-controls').hidden = !visible;
  }
  async function displayFrame(frame) {
    const history = state.replay != null;
    text($('#frame-mode'), history ? 'Recorded state' : 'Latest saved state');
    text($('#frame-label'), `${history ? 'Recorded' : 'Latest'} · turn ${frame.turn ?? '—'}${frame.time ? ' · ' + frame.time : ''}`);
    const entries = Object.entries(frame.metrics ?? {}).filter(([, value]) => ['number', 'string', 'boolean'].includes(typeof value)).slice(0, 8);
    if (frame.usage?.totalTokens != null) entries.unshift(['Tokens', frame.usage.totalTokens]);
    changed($('#world-metrics'), entries, () => entries.map(([key, value]) => fact(friendly(key), value)));
    try {
      const signature=JSON.stringify(frame);
      if (state.renderer) {if(state.frameSignature!==signature){await state.renderer.update(frame);state.frameSignature=signature;}}
      else changed($('#world'), frame.state ?? frame, () => [jsonTree(document,frame.state??frame,{label:'World state',onText:showText})]);
    } catch (error) { showError(Error(`World view: ${error.message}`)); }
    controls();
  }
  async function renderWorld(payload, key, generation) {
    state.world = payload; state.frames = payload.frames ?? []; state.control = payload.control ?? {};
    $('#world-section').hidden = false;
    $('#frame').disabled = !state.frames.length;
    $('#frame').max = Math.max(0, state.frames.length - 1);
    const moduleURL = payload.view?.module ? rendererURL(payload.view.module, window.location.href) : null;
    if (moduleURL !== state.rendererURL || key !== state.rendererKey) {
      try { state.renderer?.dispose(); } catch (error) { showError(error); }
      state.renderer = null; state.rendererURL = moduleURL; state.rendererKey = key;
      const epoch = ++state.renderEpoch;state.frameSignature=null; $('#world').replaceChildren(); $('#world')._signature = undefined;
      if (moduleURL) {
        try {
          const module = await import(moduleURL);
          if (epoch !== state.renderEpoch || generation !== state.generation) return;
          if (typeof module.mount !== 'function') throw Error('Renderer must export mount(element, context).');
          const instance = await module.mount($('#world'), {runId: state.runId, jobId: state.jobId, metadata: payload.metadata ?? {}, theme,
            inspect:selection=>{if(epoch===state.renderEpoch)inspect(selection);},selectMember:id=>epoch===state.renderEpoch?selectMember(id):Promise.resolve(null)});
          if (epoch !== state.renderEpoch || generation !== state.generation) { instance?.dispose?.(); return; }
          if (!instance || typeof instance.update !== 'function' || typeof instance.dispose !== 'function') {
            instance?.dispose?.(); throw Error('Renderer must return update(frame) and dispose().');
          }
          state.renderer = instance;
        } catch (error) { showError(Error(`World renderer: ${error.message}`)); }
      }
    }
    if (generation !== state.generation) return;
    if (state.replay == null) {
      $('#frame').value = Math.max(0, state.frames.length - 1);
      await displayFrame(payload.snapshot ?? {});
    } else {
      const index = state.frames.findIndex(frame => frameIndex(frame) === state.replay);
      if (index >= 0) $('#frame').value = index;
    }
    renderEvents(payload.events??[]);
    controls();
  }
  async function refresh(force = false) {
    if (state.stopped || state.frozen && !force) return;
    if (state.refreshing) { state.pending ||= force; return; }
    state.refreshing = true;
    const generation = state.generation;
    try {
      const overview = await api('/api/runs');
      if (generation !== state.generation) return;
      renderOverview(overview);
      if (state.runId) {
        const base = `/api/runs/${encodeURIComponent(state.runId)}`;
        const detail = await api(base);
        if (generation !== state.generation) return;
        const jobs = detail.jobs ?? [];
        if (!jobs.some(job => job.id === state.jobId)) {
          state.jobId = (jobs.find(job => active(job.status)) ?? jobs[0])?.id ?? null;
          updateHash();
        }
        renderRun(detail);
        if (state.jobId) {
          const path = `${base}/jobs/${encodeURIComponent(state.jobId)}`;
          const selected = await api(path);
          if (generation !== state.generation) return;
          renderJob(selected);
          if (kindOf(selected) === 'swarm') {
            const world = await api(path + '/world');
            if (generation !== state.generation) return;
            await renderWorld(world, `${state.runId}/${state.jobId}`, generation);
            await loadMembers(generation);
          }
        } else {
          text($('#job-title'), 'Waiting for a worker'); text($('#job-kind'), ''); text($('#job-status'), '');
        }
      }
      text($('#updated'), `Updated ${new Date().toLocaleTimeString()}`);
      if(state.refreshError){state.refreshError=false;showError(null);}
    } catch (error) { if (generation === state.generation){state.refreshError=true;showError(error);} }
    finally {
      state.refreshing = false;
      if (state.pending) { state.pending = false; refresh(true); }
    }
  }
  const savedFilters = new URL(window.location.href).searchParams;
  for (const key of ['activity', 'kind']) {
    const select = $('#' + key + '-filter'), value = savedFilters.get(key);
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }
  $('#filters').addEventListener('submit', event => event.preventDefault());
  for (const key of ['system', 'activity', 'kind']) $('#' + key + '-filter').addEventListener('change',event=>{
    const value = event.target.value;
    if (key === 'system') state.systemFilter = value;
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  });
  for (const id of ['system-filter', 'activity-filter', 'kind-filter', 'search']) $( '#' + id).addEventListener(id === 'search' ? 'input' : 'change', renderRuns);
  $('#close-run').addEventListener('click', () => selectRun(null));
  $('#overview-toggle').addEventListener('click',()=>{state.overviewExpanded=!state.overviewExpanded;$('#overview').classList.toggle('overview-compact',!state.overviewExpanded);$('#overview-toggle').setAttribute('aria-expanded',String(state.overviewExpanded));text($('#overview-toggle'),state.overviewExpanded?'Close run list':'Browse runs');});
  $('#inspect-worker').addEventListener('click',inspectWorker);
  const openInspector=()=>{$('main').classList.add('details-open');$('#inspector').focus({preventScroll:true});};
  $('#show-inspector').addEventListener('click',openInspector);
  $('#toggle-inspector').addEventListener('click',openInspector);
  $('#close-inspector').addEventListener('click',()=>{$('main').classList.remove('details-open');$('#toggle-inspector').focus({preventScroll:true});});
  $('#transcript-source').addEventListener('change',event=>loadSource(event.target.value));
  $('#open-transcript').addEventListener('click',()=>showConsole(state.job?.kind==='program'?'output':'transcript',{focus:true}));
  $('#console-member').addEventListener('change',event=>selectMember(event.target.value));
  $('#console-follow').addEventListener('click',()=>{state.follow=!state.follow;$('#console-follow').setAttribute('aria-pressed',String(state.follow));if(state.follow)scrollConsole(consoleNode(),consoleNode().scrollHeight);});
  for(const node of document.querySelectorAll('.console-content'))node.addEventListener('scroll',()=>{
    if(node!==consoleNode()||Math.abs(node.scrollTop-(node._programScrollTop??-1))<1)return;
    if(state.follow&&node.scrollHeight-node.clientHeight-node.scrollTop>4){state.follow=false;$('#console-follow').setAttribute('aria-pressed','false');}
  },{passive:true});
  const selectionCleanup=[...document.querySelectorAll('.console-content')].map(node=>installConsoleSelection(node,{onSelectionStart:()=>{state.follow=false;$('#console-follow').setAttribute('aria-pressed','false');}}));
  $('#console-search').addEventListener('input',()=>{state.follow=false;$('#console-follow').setAttribute('aria-pressed','false');consoleNode()._signature=undefined;renderConsoleText();});
  $('#console-next').addEventListener('click',()=>{const root=consoleNode(),matches=[...root.querySelectorAll('mark,[data-search-match=true]')];if(!matches.length)return;const current=matches.findIndex(mark=>mark.classList.contains('current-match'));matches.forEach(mark=>mark.classList.remove('current-match'));const next=matches[(current+1)%matches.length];next.classList.add('current-match');root.scrollTop+=next.getBoundingClientRect().top-root.getBoundingClientRect().top-30;});
  for(const button of document.querySelectorAll('[data-console]')) {
    button.addEventListener('click',()=>showConsole(button.dataset.console));
    button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-console]')].filter(tab=>!tab.hidden),index=tabs.indexOf(button);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;showConsole(tabs[next].dataset.console);tabs[next].focus();});
  }
  const legends={agent:['Agent','One agent carrying out an assignment.'],goal:['Goal','Implementation followed by independent verification.'],
    senate:['Senate','A princeps senatus and senators deliberate and produce a decision.'],swarm:['Swarm','Multiple agents explore a world using evaluator feedback.'],
    program:['Program work','A program executed by the runtime. Select its task to read output and exit details.'],
    human:['Human work','A task answered by a person.'],gateway:['Gateway / routing','The gateway mark forks or joins workflow paths. Select a gateway for its exact type and connections.'],
    event:['Start / end','An ink tick identifies a workflow event. Start and end events mark where a path begins or finishes.']};
  for(const button of document.querySelectorAll('[data-legend]')) {
    const kind=button.dataset.legend;
    const icon=button.querySelector('i');
    if(kind==='event')icon.style.background=workColor(kind);
    else {
      const symbol=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(symbol.namespaceURI,'path');
      symbol.setAttribute('viewBox','0 0 24 21');symbol.setAttribute('class','legend-mark');symbol.setAttribute('aria-hidden','true');
      for(const [key,value]of Object.entries(markAttributes(theme,{gateway:kind==='gateway'})))path.setAttribute(key,value);
      path.setAttribute('fill',workColor(kind));symbol.append(path);icon.replaceWith(symbol);
    }
    button.addEventListener('click',()=>{const [title,description]=legends[kind];inspect({title,description:description+' Color identifies the kind of work; status is written beneath the task.',data:{symbol:kind}});});
  }
  $('.identity').addEventListener('click', event => { event.preventDefault(); selectRun(null); window.scrollTo({top: 0}); });
  $('#freeze').addEventListener('click', () => {
    state.frozen = !state.frozen; $('#freeze').setAttribute('aria-pressed', String(state.frozen));
    if (state.frozen) state.generation++;
    text($('#freeze'), state.frozen ? 'Resume display' : 'Freeze display');
    $('#notice').hidden = !state.frozen;
    text($('#notice'), 'Display frozen. Execution continues. Resume the display to see current work or send execution controls.');
    controls(); if (!state.frozen) refresh(true);
  });
  $('#world-live').addEventListener('click', () => {
    state.replay = null; text($('#world-live'), 'Latest');
    if (state.world) displayFrame(state.world.snapshot ?? {});
  });
  $('#frame').addEventListener('input', async event => {
    const item = state.frames[Number(event.target.value)]; if (!item) return;
    const index = frameIndex(item), generation = state.generation;
    state.replay = index; text($('#world-live'), 'Return to latest'); controls();
    try {
      const frame = await api(`/api/runs/${encodeURIComponent(state.runId)}/jobs/${encodeURIComponent(state.jobId)}/frames/${encodeURIComponent(index)}`);
      if (generation === state.generation && state.replay === index) await displayFrame(frame);
    } catch (error) { showError(error); }
  });
  for (const button of document.querySelectorAll('[data-control]')) button.addEventListener('click', async () => {
    if (state.frozen || state.replay != null || !state.control[button.dataset.control]) return;
    const generation = state.generation; button.disabled = true;
    try {
      await api(`/api/runs/${encodeURIComponent(state.runId)}/jobs/${encodeURIComponent(state.jobId)}/control`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: button.dataset.control})});
      if (generation === state.generation) { text($('#control-feedback'), `${friendly(button.dataset.control)} requested; waiting for execution to report its state.`); refresh(true); }
    } catch (error) { showError(error); } finally { if (generation === state.generation) controls(); }
  });
  function hashChanged() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const run = hash.get('run'), job = hash.get('job');
    if (run !== state.runId || job !== state.jobId) selectRun(run, job);
  }
  window.addEventListener('hashchange', hashChanged);
  function stop() { state.stopped = true; window.clearTimeout(state.timer); workflowViewport.dispose(); disposeWorld();for(const cleanup of selectionCleanup)cleanup(); }
  window.addEventListener('pagehide', stop, {once: true});
  const initial = new URLSearchParams(window.location.hash.slice(1));
  state.runId = initial.get('run'); state.jobId = initial.get('job');
  async function poll() {
    await refresh();
    if (!state.stopped) state.timer = window.setTimeout(poll, 1800);
  }
  poll();
  return {stop, refresh, selectRun, selectJob};
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') startDashboard(document, window);
