import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from './brain-store.js';

export const BRAIN_PROMPT = 'You are a text-only reasoning assistant. You have no tools, filesystem, browser, skills, or access to the caller conversation. Use only the supplied material. Produce a self-contained analysis, design, draft, or derivation. State missing evidence rather than inventing it. Your output is a draft for the caller to verify.';

export class BrainService {
  constructor({ dbPath = join(homedir(), '.dsh', 'plugins', 'dsh-tabbit-brain', 'state', 'brain.sqlite') } = {}) {
    this.store = BrainStore.open(dbPath);
    this.queues = new Map(); this.controllers = new Set(); this.closed = false;
  }
  key(owner, conversation) { if (!owner || typeof owner !== 'string') throw new Error('A main-conversation owner id is required'); if (!conversation || typeof conversation !== 'string' || conversation.length > 100) throw new Error('Invalid conversation label'); return JSON.stringify([owner, conversation]); }
  conversation(owner, label, model) { return this.store.listConversations(owner, true).find(x => x.title === label) ?? this.store.createConversation(owner, label, model); }
  ask(request, options) {
    if (this.closed) return Promise.reject(new Error('Brain service is disposed'));
    const owner=request.owner, label=request.conversation ?? 'default'; const key=this.key(owner,label);
    const prior=this.queues.get(key) ?? Promise.resolve(); const next=prior.catch(()=>{}).then(()=>this.run(owner,label,request,{...options}));
    this.queues.set(key,next); void next.finally(()=>{if(this.queues.get(key)===next)this.queues.delete(key)}).catch(()=>{}); return next;
  }
  async run(owner,label,request,options) {
    if (this.closed) throw new Error('Brain service is disposed'); request.signal?.throwIfAborted();
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('A non-empty prompt is required');
    const budget=options.contextBudgetChars ?? 16000, system=options.brainPrompt ?? BRAIN_PROMPT;
    const conv=this.conversation(owner,label,options.agentModel);
    const history=this.store.listMessages(owner,conv.id,100,null); let remaining=budget-system.length-request.prompt.length; const retained=[];
    for(let i=history.length-2;i>=0;i-=2){const pair=history.slice(i,i+2);const cost=pair.reduce((n,m)=>n+m.content.length,0);if(cost>remaining)break;retained.unshift(...pair);remaining-=cost}
    if(remaining<0) throw new Error('Current prompt exceeds context budget; split the task');
    const messages=[{role:'system',content:system},...retained,{role:'user',content:request.prompt}];
    const base=String(options.gatewayUrl||'').replace(/\/+$/,'').replace(/\/v1$/,''); const url=new URL(base);
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password) throw new Error('Brain gateway must be a credential-free loopback HTTP endpoint');
    const apiKey=options.apiKey ?? process.env[options.apiKeyEnv||'TABBIT_API_KEY']; if(!apiKey) throw new Error('Set the gateway API key environment variable before calling tabbit_brain');
    const ctrl=new AbortController();this.controllers.add(ctrl);const abort=()=>ctrl.abort(request.signal?.reason);request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();const timer=setTimeout(()=>ctrl.abort(new Error('Brain request timed out')),options.requestTimeoutMs??120000);const requestId=randomUUID();
    try{
      const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',redirect:'error',signal:ctrl.signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`,'X-Brain-Conversation-Id':conv.id,'X-Brain-Request-Id':requestId},body:JSON.stringify({model:options.agentModel,messages,stream:false})});
      if(!response.ok){await response.body?.cancel();throw new Error(`Brain gateway HTTP ${response.status}; inspect the gateway without exposing credentials`)}
      const data=await response.json();const content=data?.choices?.[0]?.message?.content;if(typeof content!=='string'||!content.trim())throw new Error('Brain gateway returned empty text');if(typeof data.model!=='string'||data.model!==options.agentModel)throw new Error('Brain gateway response model does not match requested model');
      this.store.appendMessages(conv.id,[{role:'user',content:request.prompt,requestId,model:data.model},{role:'assistant',content,requestId,model:data.model}]);
      return {conversationId:conv.id,conversation:label,requestId,model:data.model,endpoint:`${base}/v1/chat/completions`,content,usage:data.usage??null};
    }finally{clearTimeout(timer);request.signal?.removeEventListener('abort',abort);this.controllers.delete(ctrl)}
  }
  list(owner,includeArchived=false){return this.store.listConversations(owner,includeArchived)}
  read(owner,id,limit=50,before=null){return this.store.listMessages(owner,id,limit,before)}
  archive(owner,id){return this.store.setStatus(owner,id,'archived')}
  delete(owner,id){return this.store.deleteConversation(owner,id)}
  createJob(owner,label,prompt,options){
    this.key(owner,label);
    const conv=this.conversation(owner,label,options.agentModel);
    return {...this.store.createJob({ownerSessionId:owner,conversationId:conv.id,prompt}),conversationId:conv.id};
  }
  async runJob(owner,id,options,signal){
    const job=this.store.getJob(owner,id);
    if(!job||job.status!=='queued')throw new Error('Owned queued Brain job not found');
    const conv=this.store.getConversation(owner,job.conversationId);
    this.store.updateJob(id,{status:'running',started_at:Date.now()});
    try{
      const result=await this.ask({owner,conversation:conv.title,prompt:job.prompt,signal},options);
      this.store.updateJob(id,{status:'completed',request_id:result.requestId,result_json:JSON.stringify(result),finished_at:Date.now()});
      return result;
    }catch(e){
      this.store.updateJob(id,{status:signal?.aborted?'cancelled':'failed',error:'Brain request failed; check gateway and request configuration',finished_at:Date.now()});
      throw e;
    }
  }
  status(owner,id){return this.store.getJob(owner,id)}
  reset(owner,label='default'){
    if(this.queues.has(this.key(owner,label)))throw new Error('Conversation is busy');
    const c=this.store.listConversations(owner,true).find(x=>x.title===label);
    return c?{removed:this.store.clearMessages(owner,c.id),conversationId:c.id}:{removed:false,conversation:label};
  }
  release(owner){ /* Persisted history survives agent disposal. */ }
  dispose(){this.closed=true;for(const c of this.controllers)c.abort(new Error('Brain service disposed'));this.store.close()}
}
