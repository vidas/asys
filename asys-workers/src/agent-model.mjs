import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { groupModels, listProviderModels, streamProvider } from './provider-adapter.mjs';

// Register the endpoint's public catalogue while preserving native model identities
// inside Provider messages. Pi uses the public route for every request, including compaction.
export async function agentModel({ config, agentDir, provider: providerClient, signal, event, beforeRequest }) {
  const recovery = {
    onExhaustion: ({ retryAt, ...data }) => event('agent.provider_exhausted', { ...data, retryAt: retryAt.toISOString() }),
    onRetry: ({ retryAt, ...data }) => event('agent.provider_retrying', { ...data, retryAt: retryAt.toISOString() }),
  };
  const catalogue = await listProviderModels(providerClient, { signal }, recovery);
  const groups = groupModels(catalogue.models, { onInvalid: message => event('agent.model_unavailable', { message }) });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, signal });
  let selected;
  for (const [provider, routes] of groups) {
    modelRuntime.registerProvider(provider, {
      name: provider, api: 'cyclo-pi', baseUrl: 'http://dcomp', apiKey: 'dcomp', authHeader: false,
      models: routes.map(r => r.model),
      streamSimple(model, context, options = {}) {
        signal.throwIfAborted();
        options.signal?.throwIfAborted();
        const route = routes.find(r => r.model.id === model.id);
        if (!route) throw new Error('Pi selected a model outside the Provider catalogue');
        beforeRequest(context);
        // Count the logical inference call once; transport retries stay inside
        // streamProvider and preserve this context, including completed tools.
        return streamProvider(providerClient, route.publicId, { ...model, api: 'cyclo-pi' }, context,
          { ...options, ...config.options,
            signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) },
          { idleTimeoutMs: config.inferenceIdleTimeoutMs, ...recovery });
      },
    });
    for (const route of routes) if (route.publicId === config.model) selected = modelRuntime.getModel(provider, route.model.id);
  }
  if (!selected) throw new Error(`Provider has no usable model ${config.model}`);
  return { modelRuntime, model: selected };
}
