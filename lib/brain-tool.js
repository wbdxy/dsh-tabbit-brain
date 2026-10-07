import { defineTool } from '@deepseek-ai/dsh-tools';

export function installBrainTools(ctx, service, readOptions, ensureGateway) {
  const mounted = new Map();
  const install = (agent) => {
    if (mounted.has(agent)) return;
    const fiber = agent.ctx.inject(['tools', 'jobs'], runtime => {
      const ask = async (args, signal) => {
        const options = { ...readOptions(), ...(args.model ? { agentModel: args.model } : {}) };
        const gateway = await ensureGateway(options);
        signal.throwIfAborted();
        if (gateway.ok === false) throw new Error(`Brain gateway unavailable (${gateway.action})`);
        return service.ask({ owner: agent.session.id, conversation: args.conversation || 'default',
          prompt: args.prompt, signal }, options);
      };
      runtime.tools.register(defineTool({
        name: 'tabbit_brain',
        description: 'Ask a private Tabbit reasoning conversation, not a DSH child agent. Text input only; supply material because main-chat history, DSH skills, local files and attachments are not passed automatically. Tabbit-owned Skill/妙招 retrieval and upstream search/fetch are available with site limits; verify results. Browser-task events are not a verified user-browser control channel, and browser_control text is not executed here. No local execution. Optionally set model to any model id exposed by the configured gateway for this request; otherwise the configured agentModel is used. Background by default: collect jobId with job_output, cancel with job_kill; brainJobId is for persistent status. Reuse conversation for follow-ups.',
        parameters: {
          description: { type: 'string', required: true, description: 'Short task label' },
          prompt: { type: 'string', required: true, description: 'Self-contained task and material' },
          conversation: { type: 'string', description: 'History label within this main session; default is default. Use a different label for independent tasks.' },
          model: { type: 'string', description: 'Override the configured model with any model id exposed by the gateway for this request.' },
          run_in_background: { type: 'boolean', description: 'Default true. False waits for text.' },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (args.run_in_background === false) return { kind: 'foreground', ...await ask(args, exec.signal) };
          exec.signal.throwIfAborted();
          const options = { ...readOptions(), ...(args.model ? { agentModel: args.model } : {}) };
          const persistent = service.createJob(agent.session.id, args.conversation || 'default', args.prompt, options);
          const jobId = runtime.jobs.start({ kind: 'tabbit-brain', label: args.description, owner: exec.agent,
            run: () => {
              const ctrl = new AbortController();
              const done = (async () => {
                const gateway = await ensureGateway(options);
                if (gateway.ok === false) throw new Error(`Brain gateway unavailable (${gateway.action})`);
                return service.runJob(agent.session.id, persistent.id, options, ctrl.signal);
              })().then(
                result => ({ status: 'completed', output: JSON.stringify(result) }),
                () => ({ status: ctrl.signal.aborted ? 'killed' : 'failed', output: 'Brain request failed; inspect the owned Brain job status for details.' }),
              );
              return { cancel: reason => ctrl.abort(reason || 'Brain job cancelled'), done };
            } });
          return { kind: 'background', jobId, brainJobId: persistent.id, conversationId: persistent.conversationId, conversation: args.conversation || 'default' };
        },
      }));
      const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_list', description: 'List Brain conversations owned by this main session.',
        parameters: { includeArchived: { type: 'boolean' }, limit: { type: 'number' } }, output: jsonOutput,
        execute: args => service.list(agent.session.id, args.includeArchived === true).slice(0, args.limit || 50),
      }));
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_read', description: 'Read paginated messages from an owned Brain conversation.',
        parameters: { conversationId: { type: 'string', required: true }, limit: { type: 'number' }, before: { type: 'number' } }, output: jsonOutput,
        execute: args => service.read(agent.session.id, args.conversationId, args.limit || 50, args.before ?? null),
      }));
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_archive', description: 'Archive an owned Brain conversation.',
        parameters: { conversationId: { type: 'string', required: true } }, output: jsonOutput,
        execute: args => service.archive(agent.session.id, args.conversationId),
      }));
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_delete', description: 'Permanently delete an owned Brain conversation and its messages.',
        parameters: { conversationId: { type: 'string', required: true } }, output: jsonOutput,
        execute: args => service.delete(agent.session.id, args.conversationId),
      }));
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_status', description: 'Read an owned background job status using brainJobId from the receipt, not the DSH jobId.',
        parameters: { jobId: { type: 'string', required: true } }, output: jsonOutput,
        execute: args => service.status(agent.session.id, args.jobId),
      }));
      runtime.tools.register(defineTool({
        name: 'tabbit_brain_reset', description: 'Clear local messages in one idle owned Brain conversation; remote memory remains. Use a new conversation label for independent remote context.',
        parameters: { conversation: { type: 'string', description: 'Conversation label; defaults to default' } }, output: jsonOutput,
        execute: args => service.reset(agent.session.id, args.conversation || 'default'),
      }));
    });
    mounted.set(agent, fiber);
  };
  const remove = agent => { const fiber = mounted.get(agent); mounted.delete(agent); service.release(agent.session.id); if (fiber) void fiber.dispose(); };
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => remove(agent));
  for (const agent of ctx.agents.list()) install(agent);
  ctx.effect(() => () => { service.dispose(); for (const agent of [...mounted.keys()]) remove(agent); });
}
