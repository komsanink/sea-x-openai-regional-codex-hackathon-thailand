import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toStrictJsonSchema } from 'openai/lib/transform';

process.env.BOP_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'offline-test-key';
process.env.BOP_CACHE_DIR = await mkdtemp(join(tmpdir(), 'bop-schema-contract-'));
delete process.env.BOP_FAKE_LLM;
const { model } = await import('../server/model.mjs');
const { shapes } = await import('../server/model-shapes.mjs');
const { planTrip } = await import('../server/plan.mjs');
const { normalize } = await import('../server/domain.mjs');
const { candidates } = await import('../server/candidates.mjs');
after(() => rm(process.env.BOP_CACHE_DIR, { force: true, recursive: true }));
const ctx = () => ({ signal: new AbortController().signal, step: () => {}, emit: () => {}, usage: {} });
function assertClosed(schema) {
  if (schema.properties) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    for (const child of Object.values(schema.properties)) assertClosed(child);
  }
  if (schema.items) assertClosed(schema.items);
  for (const branch of schema.anyOf ?? []) assertClosed(branch);
}
// Simulate Responses returning null for every unavailable field in its closed schema.
function fill(schema, data) {
  if (data == null) return null;
  if (schema.anyOf) {
    const observed = Array.isArray(data) ? 'array' : typeof data;
    const branch = schema.anyOf.find(
      (b) => b.type === observed || (Array.isArray(b.type) && b.type.includes(observed)),
    );
    return branch ? fill(branch, data) : data;
  }
  if (schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, fill(value, data[key])]),
    );
  return schema.items && Array.isArray(data) ? data.map((item) => fill(schema.items, item)) : data;
}
function completion(value) {
  const event = {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    },
  };
  return new Response('event: response.completed\ndata: ' + JSON.stringify(event) + '\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
test('every SDK request carries a named Responses-compatible JSON Schema with optional facts represented by null', async (t) => {
  const responses = {
    lodging: { options: [{ name: 'City Hotel', query: 'City Hotel', why: 'Close to the itinerary' }] },
    design: { days: [{ title: 'd1', stops: [] }] },
    daily: { days: [{ title: 'd1', stops: [] }] },
    skeleton: { days: [] },
    transport: { options: [] },
    research: {},
    pages: { pages: [] },
    candidates: { questions: [] },
    repair: { edits: [] },
    replan: { options: [] },
  };
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/responses');
    const { text, store, stream } = JSON.parse(init.body);
    assert.equal(store, false);
    assert.equal(stream, true);
    assert.equal(text.verbosity, 'low');
    const { format } = text;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, false);
    assertClosed(format.schema);
    assert.doesNotThrow(() => toStrictJsonSchema(format.schema));
    const operation = format.name.replace(/^bop_/, '');
    seen.push(operation);
    return completion(fill(format.schema, responses[operation]));
  });
  for (const operation of Object.keys(shapes)) await model('test', {}, { ...ctx(), operation });
  assert.deepEqual(seen, Object.keys(shapes));
});
test('candidate selection, short design and targeted repair use the real adapter and preserve unchanged stop fields', async (t) => {
  const seen = [];
  const coordinates = [18.789, 98.987];
  const place = 'River Lunch';
  const grade = { name: 'Nok', avoid: 'กุ้ง' };
  const setup = normalize({ city: 'เชียงใหม่', startDate: '2026-11-25', days: 1, members: [grade] });
  const dishes = [
    {
      id: 'd1_a',
      name: place,
      kind: 'food',
      start: '12:00',
      end: '13:00',
      meal: 'lunch',
      ll: coordinates,
      diet: false,
      cost: 65,
    },
    {
      id: 'd1_b',
      name: 'River dinner',
      kind: 'food',
      start: '18:00',
      end: '19:00',
      meal: 'dinner',
      ll: coordinates,
      diet: true,
      cost: 80,
    },
  ];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.hostname.includes('photon'))
      return Response.json({
        features: [
          {
            properties: { name: place, osm_key: 'amenity' },
            geometry: { coordinates: [...coordinates].reverse() },
          },
        ],
      });
    if (url.hostname === 'rice.example')
      return new Response(
        '<head><title>River Lunch</title><meta property="og:image" content="https://rice.example/soup.jpg"></head>',
        { headers: { 'content-type': 'text/html' } },
      );
    assert.equal(url.hostname, 'api.openai.com');
    const body = JSON.parse(init.body);
    const operation = body.text.format.name.slice(4);
    seen.push(operation);
    let result;
    if (operation === 'candidates')
      result = {
        questions: [
          {
            kind: 'food',
            title: 'Lunch?',
            options: [{ name: place, query: place, photoPage: 'https://rice.example/lunch' }],
          },
        ],
      };
    if (operation === 'design') {
      assert.ok(body.input.at(-1).content.includes(place));
      result = { days: [{ title: 'By the river', stops: dishes }], summary: 'Lunch and dinner' };
    }
    if (operation === 'repair') {
      assert.equal(body.tools, undefined);
      assert.equal(body.input[1].role, 'assistant');
      result = { edits: [{ op: 'replace', id: 'd1_a', stop: { diet: ['กุ้ง'] } }] };
    }
    assert.ok(result, 'unexpected operation ' + operation);
    return completion(fill(body.text.format.schema, result));
  });
  const discovery = await candidates(setup, ctx());
  setup.picks = { must: [discovery.questions[0].options[0]], avoid: [] };
  const events = [];
  const planned = await planTrip(setup, { ...ctx(), emit: event => events.push(event.type) });
  assert.deepEqual(seen, ['candidates', 'candidates', 'candidates', 'design', 'repair']);
  assert.equal(planned.repaired, true);
  const outcome = planned.plan.repairOutcome;
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.before.passed, outcome.after.passed - 1);
  assert.deepEqual(outcome.before.failures.map((rule) => rule.label), ['Nok · ไม่ทาน กุ้ง']);
  assert.match(outcome.before.failures[0].detail, /River Lunch/);
  assert.doesNotMatch(outcome.before.failures[0].detail, /id d1_a/);
  assert.deepEqual(outcome.after.failures, []);
  assert.deepEqual(outcome.changes, ['วันที่ 1 · ปรับมื้ออาหารที่ River Lunch']);
  assert.deepEqual(events, ['map', 'map', 'map', 'day']);
  assert.equal(planned.plan.days.length, 1);
  assert.equal(planned.plan.days[0].stops.length, 2);
  const stop = planned.plan.days[0].stops[0];
  assert.equal(stop.name, place);
  assert.equal(stop.cost, 65);
  assert.equal(stop.start, '12:00');
  assert.deepEqual(stop.diet, ['กุ้ง']);
  assert.deepEqual(stop.ll, coordinates);
  assert.ok(planned.plan.report.list.every((r) => r.pass));
});
