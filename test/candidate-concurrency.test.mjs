import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

process.env.BOP_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'fixture-key';
delete process.env.BOP_FAKE_LLM;
const { candidates } = await import('../server/candidates.mjs');
const { normalize } = await import('../server/domain.mjs');
const setup = normalize({ city: 'London', country: 'GB', cityLL: [51.5, -.12], days: 3,
  startDate: '2026-11-22', members: [{name: 'Traveler'}] });
const context = controller => ({ signal: controller.signal, usage: {}, step() {} });
const readInput = init => JSON.parse(JSON.parse(init.body).input[0].content.split('ข้อมูล JSON:\n')[1]);
const reply = (questions, sources = []) => {
  const response = { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
    output: [{ id:'search', type:'web_search_call', action:{ sources } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({questions}) }] }] };
  return new Response('data: ' + JSON.stringify({ type:'response.completed', response }) + '\n\n',
    { headers: { 'content-type':'text/event-stream' } });
};

test('independent category searches start together and aggregate provider usage before one shared top-up', async t => {
  const waits = { stay: 90, food: 75, sight: 60 };
  const invoked = [], completed = [], joined = Promise.withResolvers();
  let intervalStart, intervalEnd;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.openai.com');
    const input = readInput(init), [kind] = input.categories;
    if (input.gaps) {
      assert.equal(completed.length, 3);
      assert.deepEqual(input.categories, ['stay','food','sight']);
      return reply([]);
    }
    intervalStart ??= performance.now();
    invoked.push(kind);
    if (invoked.length === 3) joined.resolve();
    await joined.promise; // A sequential implementation cannot release this barrier.
    await delay(waits[kind], undefined, {signal:init.signal});
    completed.push(kind);
    intervalEnd = performance.now();
    return reply([]);
  });
  const controller = new AbortController();
  const stop = setTimeout(() => { joined.resolve(); controller.abort(); }, 5000);
  try {
    const result = await candidates(setup, context(controller));
    assert.deepEqual(new Set(invoked), new Set(Object.keys(waits)));
    assert.deepEqual(result.questions, []);
    assert.equal(result.usage.web_search_requests, 4);
    assert.equal(result.usage.input_tokens, 40);
    assert.equal(result.usage.output_tokens, 20);
    const start = performance.now();
    for (const ms of Object.values(waits)) await delay(ms);
    t.diagnostic('Three mocked category waits: ' + Math.round(performance.now() - start) +
      ' ms serial, ' + Math.round(intervalEnd - intervalStart) + ' ms in the concurrent first round');
  } finally { clearTimeout(stop); }
});

test('a failed category is retried in the shared gap request and healthy choices survive a failed retry', async t => {
  const setupDay = { ...setup, days: 1 };
  const kinds = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const dest = new URL(url);
    if (dest.hostname === 'venues.example') return new Response('<title>' + dest.pathname.slice(1) +
      '</title><meta property="og:image" content="https://images.example/' + dest.pathname.slice(1) + '.jpg">',
      {headers:{'content-type':'text/html'}});
    if (dest.hostname !== 'api.openai.com') return Response.json({features: []});
    const input = readInput(init);
    kinds.push(input.categories);
    if (input.categories.includes('food')) return Response.json({ error: {code:'invalid_api_key'} }, {status:401});
    const options = ['Park01','Park02','Park03','Park04'].map(name => ({name, query: name,
      src:{checked:'web',url:'https://venues.example/' + name}}));
    return reply([{kind:'sight',options}],options.map(o=>({url:o.src.url})));
  });
  const result = await candidates(setupDay, context(new AbortController()));
  assert.deepEqual(kinds,[['food'],['sight'],['food']]);
  assert.deepEqual(result.questions.map(q => [q.kind,q.options.length]),[['sight',4]]);
});

test('aborting discovery cancels all in-flight categories and never starts a top-up', async t => {
  const controller = new AbortController(), running = [];
  t.mock.method(globalThis, 'fetch', (_, init) => new Promise((resolve, reject) => {
    running.push(readInput(init).categories[0]);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true});
    if (running.length === 3) controller.abort();
  }));
  await assert.rejects(candidates(setup, context(controller)), {name:'AbortError'});
  assert.deepEqual(running,['stay','food','sight']);
});
