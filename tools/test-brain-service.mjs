import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrainService } from '../lib/brain-service.js';
const requests=[];
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);requests.push(body);
 if(body.messages.at(-1).content==='FAIL'){res.writeHead(401);res.end('invalid credential');return;}
 if(body.messages.at(-1).content==='WAIT')await new Promise(r=>setTimeout(r,200));
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'TEST_MODEL',choices:[{message:{content:'answer'}}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const service=new BrainService();
const opts={gatewayUrl:`http://127.0.0.1:${server.address().port}`,agentModel:'TEST_MODEL',apiKey:'fixture-only',requestTimeoutMs:2000,contextBudgetChars:1800};
try {
 const call=(owner,prompt,extra={})=>service.ask({owner,prompt,conversation:'design',...extra},opts);
 const receipt=await call('A','first');assert.equal(receipt.model,'TEST_MODEL');
 await call('A','second');assert.equal(requests.at(-1).messages.length,4);
 await call('B','other');assert.equal(requests.at(-1).messages.length,2,'owner isolation');
 await assert.rejects(call('A','FAIL'),/HTTP 401/);
 await call('A','third');assert(!requests.at(-1).messages.some(m=>m.content==='FAIL'),'failed history not committed');
 await Promise.all([call('C','WAIT'),call('C','next')]);
 assert(requests.at(-1).messages.some(m=>m.content==='WAIT'),'same-conversation serialization');
 for(const r of requests){assert(!('tools'in r));assert(!('tool_choice'in r));}
 await assert.rejects(call('A','x'.repeat(3000)),/budget/);
 const ctrl=new AbortController();ctrl.abort();await assert.rejects(call('A','cancel',{signal:ctrl.signal}));
 service.reset('A','design');await call('A','reset');assert.equal(requests.at(-1).messages.length,2);
 console.log('PASS: direct HTTP, no tools, owner isolation, history, queue, failure rollback, budget, abort, reset');
} finally {service.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));}
