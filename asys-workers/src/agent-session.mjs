import { makeDirectory, prepareFile } from '../../asys-runtime/javascript/permissions.mjs';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { clone, requiredString } from './values.mjs';
import { agentResult } from './agent-definition.mjs';
import { workerPrompt } from './system-prompt.mjs';
import { agentModel } from './agent-model.mjs';

// Pi owns the agent loop, local tools, context management, and session format.
// Ordinary jobs are fresh. A goal may explicitly retain its implementer's session.
export async function runAgent({ config, job, signal, provider, workspace: cwd, jobDirectory, definition, sessionFile, extensionPaths = [], save, event, customTools = [] }) {
  signal.throwIfAborted();
  const agentDir = join(jobDirectory, '.pi');
  makeDirectory(agentDir, { recursive: true, mode: 0o700 });
  job.agent = {
    model: requiredString(config.model, `${job.id} model`),
    prompt: requiredString(config.prompt, `${job.id} prompt`),
    name: definition.name, environment: definition.environment, directory: definition.directory,
    promptHash: definition.promptHash, memoryHash: definition.memoryHash,
    steps: 0,
  };
  const state = job.agent;
  const sessionManager = openSession(cwd, sessionFile);
  if (sessionFile !== undefined) {
    state.sessionFile = sessionManager.getSessionFile();
    state.sessionStartEntryCount = sessionManager.getEntries().length;
    state.sessionStartLeafId = sessionManager.getLeafId();
  }
  snapshot();
  const { modelRuntime, model } = await agentModel({ config, agentDir, provider, signal, event,
    beforeRequest(context) {
      if (config.maxSteps !== undefined && state.steps >= config.maxSteps) throw new Error(`${job.id} exceeded ${config.maxSteps} inference steps`);
      state.steps++;
      snapshot();
      const promptFile = join(agentDir, 'system-prompt.txt');
      prepareFile(promptFile);
      // Pi carries the prompt as transcript system messages, not a context field.
      writeFileSync(promptFile, getCurrentSystemPrompt(context.messages));
    },
  });
  // streamProvider owns transport recovery for turns and compaction alike.
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noSkills: true, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalSkillPaths: definition.skills,
    additionalExtensionPaths: [...definition.extensions, ...extensionPaths],
    ...workerPrompt({ definition, jobDirectory, workspace: cwd }),
  });
  await resourceLoader.reload();
  const extensionErrors = resourceLoader.getExtensions().errors;
  if (extensionErrors.length) throw new Error(`Pi extension loading failed: ${extensionErrors.map(e => `${e.path}: ${e.error}`).join('; ')}`);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model,
    resourceLoader, sessionManager, settingsManager, customTools });
  const onAbort = () => {
    session.abortCompaction();
    session.abortBranchSummary();
    void session.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let compactionError;
  const unsubscribe = session.subscribe(e => {
    if (signal.aborted) return;
    if (e.type === 'message_start' && e.message.role === 'assistant') {
      // The session appends a message only when it ends. Observers use this
      // parent to replace the live text when the saved session catches up.
      event('agent.message_started', { parentId: sessionManager.getLeafId() });
    } else if (e.type === 'message_update') {
      const update = e.assistantMessageEvent;
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        event('agent.message_delta', { kind: update.type === 'text_delta' ? 'text' : 'thinking',
          contentIndex: update.contentIndex, delta: update.delta });
      }
    } else if (e.type === 'tool_execution_start') {
      event('agent.tool_started', { name: e.toolName, callId: e.toolCallId });
      snapshot();
    } else if (e.type === 'tool_execution_end') {
      event('agent.tool_completed', { name: e.toolName, callId: e.toolCallId, isError: e.isError });
    } else if (e.type === 'auto_retry_start' || e.type === 'summarization_retry_scheduled') {
      event('agent.provider_retrying', { attempt: e.attempt, maxAttempts: e.maxAttempts,
        delayMs: e.delayMs, errorMessage: e.errorMessage });
    } else if (e.type === 'compaction_start') {
      compactionError = undefined;
      event('agent.compaction_started', { reason: e.reason });
    } else if (e.type === 'compaction_end') {
      compactionError = e.errorMessage;
      // Pi has appended the compaction entry. Persist it before retrying or
      // notifying observers, which may cancel the job at this boundary.
      snapshot();
      event('agent.compaction_ended', { reason: e.reason, aborted: e.aborted, willRetry: e.willRetry,
        errorMessage: e.errorMessage, tokensBefore: e.result?.tokensBefore, tokensAfter: e.result?.estimatedTokensAfter });
    }
    if (['message_end', 'tool_execution_end'].includes(e.type)) queueMicrotask(snapshot);
  });
  function snapshot(force = false) {
    if (signal.aborted && !force) return;
    state.session = clone({ header: sessionManager.getHeader(), entries: sessionManager.getEntries(), leafId: sessionManager.getLeafId() });
    save();
  }
  try {
    let prompt = state.prompt;
    for (let correction = 0; ; correction++) {
      signal.throwIfAborted();
      await session.prompt(prompt, { expandPromptTemplates: false });
      signal.throwIfAborted();
      snapshot();
      const assistant = session.messages.at(-1);
      if (!isFinalAnswer(assistant)) throw new Error(compactionError || assistant?.errorMessage || `Agent ${job.id} did not finish`);
      try { return agentResult(assistant); }
      catch (error) {
        // Repair only the report, once, with the completed work still in context.
        if (correction) throw error;
        event('agent.result_correcting', { errorMessage: error.message });
        prompt = `Your final response was rejected: ${error.message}\n\n` +
          'Correct the response format using the work and observations already in this session. ' +
          'Return one valid JSON object with a nonempty string final, exception (null or a nonempty reason), ' +
          'and all task-specific result fields. Use double quotes for JSON strings; no Markdown fences or surrounding prose. ' +
          'Preserve the findings and outcome, including any blocker. Do not repeat completed work or run tools just to reformat the report.';
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
    try { snapshot(true); }
    finally { session.dispose(); }
  }
  function isFinalAnswer(message) {
    return message?.role === 'assistant' && message.stopReason === 'stop' && !message.content.some(c => c.type === 'toolCall');
  }
}

function openSession(cwd, sessionFile) {
  if (sessionFile === undefined) return SessionManager.inMemory(cwd);
  if (typeof sessionFile !== 'string' || !isAbsolute(sessionFile)) throw new Error('sessionFile must be an absolute path');
  makeDirectory(dirname(sessionFile), { recursive: true, mode: 0o700 });
  prepareFile(sessionFile);
  const content = readFileSync(sessionFile, 'utf8');
  if (content) {
    // Pi tolerates malformed JSONL by dropping records. Continuation must fail
    // visibly instead of silently losing completed work or changing its context.
    if (!content.endsWith('\n')) throw new Error(`Incomplete session record in ${sessionFile}`);
    let entries;
    try { entries = content.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { throw new Error(`Invalid session record in ${sessionFile}`); }
    const header = entries[0];
    if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') {
      throw new Error(`Invalid session header in ${sessionFile}`);
    }
    if (realpathSync(header.cwd) !== realpathSync(cwd)) throw new Error(`Session workspace does not match ${cwd}`);
    const ids = new Set();
    for (const entry of entries.slice(1)) {
      if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || entry.type === 'session' ||
          (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new Error(`Invalid session history in ${sessionFile}`);
      }
      ids.add(entry.id);
    }
  }
  // Opening the explicitly prepared empty file writes its header immediately.
  // Subsequent completed messages, tool results and compactions are appended by Pi.
  return SessionManager.open(sessionFile, dirname(sessionFile), cwd);
}
