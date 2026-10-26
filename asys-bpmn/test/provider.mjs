import { createServer } from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { serveOutput } from '@dcomp/component';
import { Provider } from '@cyclo/provider/contract';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { heartbeat } from '../asys-runtime/javascript/health.mjs';

const models = ['worker'].map(name => ({ id: `fixture/${name}`, displayName: name,
  inferenceFormat: 'pi-ai@1.4.0', contextWindowTokens: 100000n, maxOutputTokens: 8000n,
  capabilities: { inputModalities: [1], outputModalities: [1], functionTools: true } }));
const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
function answer(content) {
  return { role: 'assistant', content, api: 'cyclo-pi', provider: 'fixture', model: 'model',
    stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const server = createServer(connectNodeAdapter({ routes(router) { router.service(Provider, {
  listModels() { return { models }; },
  async *infer(request) {
    const { context } = JSON.parse(request.payload);
    const results = new Map(context.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
    const details = id => JSON.parse(results.get(id).content.find(c => c.type === 'text').text).id;
    let content;
    if (request.model !== 'fixture/worker') throw new Error(`Unexpected model: ${request.model}`);
    if (!getCurrentTools(context.messages).some(tool => tool.name === 'start_action')) {
      content = results.has('write') ? [{ type: 'text', text: 'The draft is ready.' }]
        : [tool('write', 'bash', { command: 'printf "draft\\n" >> proof.txt' })];
    } else if (!results.has('draft')) content = [tool('draft', 'start_action', { action: 'draft' })];
    else if (!results.has('await_draft')) content = [tool('await_draft', 'wait_action', { id: details('draft') })];
    else if (!results.has('approval')) content = [tool('approval', 'start_action', { action: 'approval' })];
    else if (!results.has('await_approval')) content = [tool('await_approval', 'wait_action', { id: details('approval') })];
    else content = [{ type: 'text', text: 'Approved.' }];
    if (!content.some(part => part.type === 'toolCall')) {
      const final=content.map(part => part.text).join('');
      content = [{ type: 'text', text: JSON.stringify({final, exception: null,
        ...(final==='The draft is ready.'?{review_summary:'Created proof.txt and checked the saved draft.',
          review_files:[{path:'proof.txt',label:'Prepared draft'}]}:{})}) }];
    }
    const message = answer(content);
    yield { payload: JSON.stringify({ type: 'done', reason: message.stopReason, message }) };
  },
}); } }));
heartbeat('/tmp/asys-provider-health');
await serveOutput(server, 'provider');
