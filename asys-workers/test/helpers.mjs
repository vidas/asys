import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
export const model = { id: 'fixture/model', displayName: 'Test model', inferenceFormat: 'pi-ai@0.99.1',
  contextWindowTokens: 100000n, maxOutputTokens: 8000n,
  capabilities: { inputModalities: [1], outputModalities: [1], functionTools: true, reasoning: false } };
// Provider payloads carry Pi's normalized transcript: the system prompt and
// tools are system messages rather than context fields.
export const systemPromptOf = context => getCurrentSystemPrompt(context.messages);
export const toolsOf = context => getCurrentTools(context.messages);
export const conversationOf = context => context.messages.filter(message => message.role !== 'system');
export function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', content, api: 'cyclo-pi', provider: 'fixture', model: 'model', stopReason,
    timestamp: Date.now(), usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

// SDK tests supply a real environment and job area without launching a runtime.
export async function runTestAgent(options) {
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { agentDefinition } = await import('../src/agent-definition.mjs');
  const { runAgent } = await import('../src/agent-session.mjs');
  const environment = options.environmentDirectory ?? join(options.workspace, 'test-environment');
  await mkdir(join(environment, 'agents', 'test'), { recursive: true });
  await mkdir(options.workspace, { recursive: true });
  return runAgent({ ...options, jobDirectory: join(options.workspace, 'test-job'), definition: agentDefinition(environment, 'test') });
}
