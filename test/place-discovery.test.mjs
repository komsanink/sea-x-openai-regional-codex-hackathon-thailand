import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpsUrl } from '../server/place-text.mjs';
import { pagePhoto, previewFromHead, publicPage } from '../server/photos.mjs';

process.env.BOP_PROVIDER = 'openai';
process.env.BOP_CACHE_DIR = await mkdtemp(join(tmpdir(), 'bop-discovery-'));
after(() => rm(process.env.BOP_CACHE_DIR, { recursive: true, force: true }));
process.env.OPENAI_API_KEY = 'research-test-key';
delete process.env.BOP_FAKE_LLM;
const { normalizeInfo, placeInfo } = await import('../server/research.mjs');
const { normalizeQuestions, resolvePicks, matchesPick, candidates } = await import(
  '../server/candidates.mjs'
);
const { normalize } = await import('../server/domain.mjs');
const signal = () => new AbortController().signal;
const context = () => ({ usage: {}, signal: signal(), step: () => {} });
function reply(value, tools = []) {
  const response = {
    status: 'completed',
    output: [...tools, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  };
  return new Response(
    'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
test('canonicalizes Markdown and rejects unsafe page inputs and previews', async (t) => {
  assert.equal(httpsUrl('![place](https://cdn.example/wat.jpg)'), 'https://cdn.example/wat.jpg');
  assert.equal(httpsUrl('<https://cdn.example/wat.jpg>'), 'https://cdn.example/wat.jpg');
  assert.equal(httpsUrl('https://a:b@cdn.example/wat.jpg'), '');
  for (const url of [
    'https://example.local/a',
    'https://127.0.0.1',
    'https://[::1]',
    'https://user@news.example/p',
    'http://news.example',
    'https://news.example:444',
  ])
    assert.equal(publicPage(url), '');
  const page = 'https://news.example/photos',
    stop = { n: 'Wat Umong' };
  const tag = (property, content) => '<meta content="' + content + '" property="' + property + '">';
  const make = (image = 'https://cdn.example/photo.jpg', title = 'Wat Umong', width = 400) =>
    tag('og:image', image) + tag('og:title', title) + tag('og:image:width', width);
  assert.equal(previewFromHead(make(), page, stop).match, 'likely');
  assert.equal(previewFromHead(make('https://cdn.example/logo.svg'), page, stop), null);
  assert.equal(previewFromHead(make(undefined, 'Wat Uma'), page, stop), null);
  assert.equal(previewFromHead(make(undefined, undefined, 120), page, stop), null);
  const og = make(undefined, 'Indian restaurant in Covent Garden | Dishoom');
  assert.ok(previewFromHead(og, 'https://www.dishoom.com/covent-garden/', { n: 'Dishoom Covent Garden' }));
  assert.equal(previewFromHead(og, 'https://www.dishoom.com/shoreditch/', { n: 'Dishoom Kensington' }), null);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 301, headers: { Location: 'https://127.0.0.1/private' } });
  });
  assert.equal(await pagePhoto(page, stop, signal()), null);
  assert.equal(calls, 1);
});
test('removes source parentheticals before bounding facts while keeping distinct cited pages', () => {
  const base = 'https://venue.example/menu';
  const cited = [base + '?utm_source=openai', base];
  const note = 'เมนูวันอาทิตย์ (ตัวอย่าง) (venue.example)';
  const info = normalizeInfo({
    cited, verified: cited, value: {
      details: { what: note, highlights: [note], hours: 'เปิด (อา.) ([ร้าน](https://venue.example/hours))' },
      summary: note, tips: [note], dishes: [{ name: 'ต้มยำ (venue.example)', why: note, veg: true }],
    },
  }, { k: 'food' });
  assert.equal(info.details.what, 'เมนูวันอาทิตย์ (ตัวอย่าง)');
  assert.deepEqual(info.details.highlights, [info.details.what]);
  assert.equal(info.summary, info.tips[0]);
  assert.equal(info.details.hours, 'เปิด (อา.)');
  assert.deepEqual(info.dishes[0], { name: 'ต้มยำ', price: null, why: info.summary, veg: true });
  assert.deepEqual(info.sources.map(s => s.url), [base]);
});
test('reads Sunday dishes with listed prices from a branch’s public embedded menu', async (t) => {
  const { publishedMenu } = await import('../server/menu-source.mjs');
  const base = 'https://venue.example', page = base + '/food/menu';
  const items = (name) => [{ '@type': 'MenuItem', name, offers: { price: '22.95', priceCurrency: 'GBP' }, suitableForDiet: 'https://schema.org/VegetarianDiet' }];
  const json = { '@type':'Menu', hasMenuSection: [
    { '@type':'MenuSection', name:'Mains', hasMenuItem: items('Pasta') },
    { '@type':'MenuSection', name:'Sunday Roasts', hasMenuItem: items('Nut roast') },
  ] };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    if (String(url) === page)
      return new Response('<head><title>The Wellington | Menus</title></head><script src="https://menus.tenkites.com/Scripts/embed.js"></script><script>var options={url:"/api/tenkites?menuId=branch"}</script>', { headers:{ 'content-type':'text/html' } });
    return Response.json('<script type="application/ld+json">' + JSON.stringify(json) + '</script>');
  });
  const stop = { n: 'The Wellington', src: { url: page }, date:'2026-11-22' };
  const result = await publishedMenu(stop, [], signal());
  assert.equal(result.page, page);
  assert.deepEqual(result.dishes.map(d => d.name), ['Nut roast','Pasta']);
  assert.deepEqual(result.dishes[0].priceLocal, { amount: 22.95, currency: 'GBP' });
  assert.equal(result.dishes[0].veg, true);
  assert.equal((await publishedMenu({ ...stop, date: '2026-11-23' }, [], signal())).dishes.length, 1);
  assert.equal(await publishedMenu({ ...stop, n: 'Other venue' }, [], signal()), null);
  assert.ok(requests.every(url => url.startsWith(base + '/')));
});
test('gives the researcher the verified menu before it describes the meal', async (t) => {
  const url = 'https://venue.example/menu';
  const structured = { '@type': 'MenuItem', name: 'Seasonal curry', offers: { price: '12.95', priceCurrency: 'GBP' } };
  const html = '<head><title>River Kitchen</title></head><script type="application/ld+json">' + JSON.stringify(structured) + '</script>';
  let prompt;
  t.mock.method(globalThis, 'fetch', async (resource, init) => {
    if (new URL(resource).hostname === 'api.openai.com') {
      prompt = JSON.parse(JSON.parse(init.body).input[0].content.split('ข้อมูล JSON:\n')[1]);
      return reply({ summary: 'ร้านครัวริมน้ำ', rate: 43, currency: 'GBP' });
    }
    assert.equal(String(resource), url);
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  });
  const { info } = await placeInfo({ city: 'London', stop: {
    id: 'weekday-meal', n: 'River Kitchen — มื้อเย็น', k: 'food', ll: [51.5, -0.1],
    place: { fallback: true }, src: { url, checked: 'web' }, date: '2026-11-22',
  } }, context());
  assert.equal(prompt.stop.ll, undefined);
  assert.equal(prompt.publishedMenu.dishes[0].name, 'Seasonal curry');
  assert.equal(info.menuSource, url);
  assert.equal(info.dishes[0].price, 557);
  assert.equal(info.dishes[0].priceLocal.amount, 12.95);
});

test('uses only the named restaurant’s linked menu on a multi-venue page', async (t) => {
  const { publishedMenu } = await import('../server/menu-source.mjs');
  const page = 'https://directory.example/alpha-restaurant/menu';
  const item = name => ({ '@type': 'MenuItem', name });
  const graph = [
    { '@type': 'Restaurant', name: 'Beta Restaurant', hasMenu: { '@type': 'Menu', hasMenuItem: item('Beta special') } },
    { '@type': 'Restaurant', name: 'Alpha Restaurant', hasMenu: { '@id': '#alpha-menu' } },
    { '@type': 'Menu', '@id': '#alpha-menu', hasMenuItem: { '@id': '#alpha-special' } },
    { ...item('Alpha special'), '@id': '#alpha-special' },
    item('Unattributed special'),
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(
    '<head><title>Alpha Restaurant and Gamma Restaurant menus</title></head>' +
    '<script type="application/ld+json">' + JSON.stringify({ '@graph': graph }) + '</script>',
    { headers: { 'content-type': 'text/html' } },
  ));
  const lookup = n => publishedMenu({ n }, [{ url: page }], signal());
  assert.deepEqual((await lookup('Alpha Restaurant')).dishes.map(d => d.name), ['Alpha special']);
  assert.equal(await lookup('Gamma Restaurant'), null);
  graph[1].hasMenu = undefined;
  assert.equal(await lookup('Alpha Restaurant'), null);
});

test('uses the visit weekday price for a dish listed in multiple menu sections', async (t) => {
  const { publishedMenu } = await import('../server/menu-source.mjs');
  const page = 'https://venue.example/alpha-restaurant/menu';
  const section = (name, prices) => ({ '@type': 'MenuSection', name,
    hasMenuItem: Object.entries(prices).map(([dish, price]) => ({ '@type': 'MenuItem', name: dish,
      offers: { priceCurrency: 'GBP', price } })) });
  const menu = { '@type': 'Menu', hasMenuSection: [
    section('Monday specials', { Roast: 15 }), section('Mains', { Pasta: 10 }),
    section('Sunday specials', { Roast: 20, Pasta: 12 }),
  ] };
  t.mock.method(globalThis, 'fetch', async () => new Response(
    '<script type="application/ld+json">' + JSON.stringify(menu) + '</script>',
    { headers: { 'content-type': 'text/html' } },
  ));
  const result = await publishedMenu({ n: 'Alpha Restaurant', date: '2026-11-22' }, [{ url: page }], signal());
  assert.deepEqual(Object.fromEntries(result.dishes.map(d => [d.name, d.priceLocal.amount])), { Roast: 20, Pasta: 12 });
});

test('places confirmed citations first, converts local prices, bounds text and hides photo hints', () => {
  const verified = new Set(['https://one.example/', 'https://two.example/']);
  const value = {
    summary: 'x'.repeat(400),
    details: { highlights: Array(9).fill('x'), what: 'z'.repeat(500) },
    confidence: 'web',
    hours: 'h'.repeat(90),
    tips: Array(8).fill('x'),
    rate: 0.0014,
    photoPage: 'https://photo.example/',
    dishes: [
      { name: 'Phở', price: 80000, priceLocal: { amount: 80000, currency: 'VND' } },
      { name: 'Tea', price: 'varies' },
    ],
    sources: [
      { url: '[1](https://one.example/)' },
      { url: 'https://invented.example/' },
      { url: 'https://two.example/' },
    ],
  };
  const result = normalizeInfo({ verified, cited: new Set(['https://two.example/']), value }, { k: 'food' });
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ['https://two.example/', 'https://one.example/'],
  );
  assert.equal(result.confidence, 'web');
  assert.equal(result.dishes[0].price, 112);
  assert.equal(result.dishes[1].price, null);
  assert.equal(result.dishes[0].priceLocal.amount, 80000);
  assert.equal(result.summary.length, 300);
  assert.equal(result.details.what.length, 400);
  assert.equal(result.hours.length, 80);
  assert.equal(result.details.highlights.length, 5);
  assert.equal(result.tips.length, 5);
  assert.equal(Object.hasOwn(result, 'photoPage'), false);
  assert.equal(Object.hasOwn(result, 'phone'), false);
  assert.equal(
    normalizeInfo({ verified, value: { ...value, confidence: 'estimate' } }, { k: 'sight' }).confidence,
    'estimate',
  );
  assert.equal(normalizeInfo({ verified, value }, { k: 'sight' }).dishes.length, 0);
});
test('matching place lookups share work, distinguish city and search inputs, and evict failures', async (t) => {
  const calls = [];
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (new URL(url).hostname !== 'api.openai.com') return Response.json({ query: { pages: [] } });
    const body = JSON.parse(init.body);
    calls.push(JSON.parse(body.input[0].content.split('ข้อมูล JSON:\n')[1]));
    if (calls.length === 1) await hold;
    if (calls.at(-1).stop.id === 'retry1' && calls.filter(call => call.stop.id === 'retry1').length === 1)
      return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
    return reply({});
  });
  const stop = {
    id: 'cafe',
    n: 'Cafe #17',
    k: 'food',
    query: 'A',
    aliases: ['X'],
    place: { query: 'B', aliases: ['Y'] },
  };
  const a = placeInfo({ stop }, context()),
    b = placeInfo({ stop, city: 'เชียงใหม่' }, context());
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].city, 'เชียงใหม่');
  assert.deepEqual(calls[0].stop.aliases, ['X', 'Y']);
  assert.equal(calls[0].stop.query, 'A');
  assert.equal(first.info.summary, 'ยังไม่มีข้อมูล');
  assert.equal(second.cached, true);
  assert.equal(first.usage.provider, 'openai');
  const named = { stop: { ...stop, n: 'renamed' } };
  await placeInfo(named, context());
  for (const input of [
    { stop, city: 'Hanoi' }, { stop: { ...stop, query: 'different branch' } },
    { stop: { ...stop, ll: [51.51,-0.13] } },
  ]) assert.equal((await placeInfo(input, context())).cached, undefined);
  const fail = { stop: { ...stop, id: 'retry1' } };
  await assert.rejects(placeInfo(fail, context()), { code: 'auth' });
  assert.equal((await placeInfo(fail, context())).cached, undefined);
  assert.equal(calls.length, 7);
  await assert.rejects(placeInfo({ stop: { n: 'no id' } }, context()), { code: 'bad_request' });
});
test('streams credited photos before menu/text, replays to a late client and shares the checked page', async (t) => {
  const one = 'https://harbour.example/menu';
  const two = 'https://hours.example/harbour-kitchen';
  const stop = { n: 'Harbour Kitchen', id: 'early-photo', k: 'food', src: { checked: 'web', url: one } };
  const firstPhoto = 'https://media.example/harbour.jpg';
  const secondPhoto = 'https://media.example/interior.jpg';
  const head = url => '<head><title>Harbour Kitchen</title><meta property="og:image" content="' + url + '"></head>';
  const firstImage = Promise.withResolvers();
  const modelStarted = Promise.withResolvers();
  const finishModel = Promise.withResolvers();
  let finishMenu;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (resource) => {
    const url = String(resource);
    calls.push(url);
    if (url === one) return new Response(new ReadableStream({ start(controller) {
      const encode = value => controller.enqueue(new TextEncoder().encode(value));
      encode(head(firstPhoto));
      finishMenu = () => {
        encode('<script type="application/ld+json">{"@type":"MenuItem","name":"Curry"}</script>');
        controller.close();
      };
    } }), { headers: { 'content-type': 'text/html' } });
    if (url === two) return new Response(head(secondPhoto), { headers: { 'content-type': 'text/html' } });
    assert.equal(new URL(url).hostname, 'api.openai.com');
    modelStarted.resolve();
    await finishModel.promise;
    return reply({ photoPage: two, sources: [{ url: one }, { url: two }], summary: 'Harbour' },
      [{ id:'search', type:'web_search_call', action:{ sources:[{ url:one }, { url:two }] } }]);
  });
  const origin = new AbortController();
  const earlyEvents = [], lateEvents = [], lateSteps = [];
  const input = { city:'London', stop };
  const first = placeInfo(input, { ...context(), signal:origin.signal, emit: e => {
    earlyEvents.push(e);
    firstImage.resolve();
  } });
  await firstImage.promise;
  assert.equal(calls.filter(url => url === one).length, 1);
  assert.ok(!calls.some(url => url.includes('api.openai.com')));
  const late = placeInfo(input, { ...context(), emit: e => lateEvents.push(e), step: text => lateSteps.push(text) });
  assert.deepEqual(lateEvents, earlyEvents);
  assert.equal(lateEvents[0].photos[0].page, one);
  assert.deepEqual(lateSteps, ['กำลังอ่านหน้าเมนูที่เผยแพร่']);
  origin.abort();
  await assert.rejects(first, {name:'AbortError'});
  finishMenu();
  await modelStarted.promise;
  assert.equal(lateEvents.length, 1);
  finishModel.resolve();
  const { info, cached } = await late;
  assert.equal(cached, true);
  assert.deepEqual(lateEvents.map(e => e.photos.map(p => p.url)), [[firstPhoto], [firstPhoto, secondPhoto]]);
  assert.deepEqual(info.photos, lateEvents.at(-1).photos);
  assert.equal(earlyEvents.length, 1);
  for (const url of [one, two, 'https://api.openai.com/v1/responses']) assert.equal(calls.filter(x => x === url).length, 1);
  const reopened = [];
  assert.equal((await placeInfo(input, { ...context(), emit: e => reopened.push(e) })).cached, true);
  assert.deepEqual(reopened, [lateEvents.at(-1)]);
});
test('closing the last subscriber aborts the shared request and permits an immediate retry', async t => {
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    if (++calls > 1) return reply({ summary: 'new lookup' });
    started.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      cancelled.resolve();
      reject(init.signal.reason);
    }, { once: true }));
  });
  const input = { city: 'London', stop: { id: 'cancelled-lookup', n: 'Waterfront', k: 'sight' } };
  const origin = new AbortController();
  const first = placeInfo(input, { ...context(), signal: origin.signal });
  await started.promise;
  origin.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const second = placeInfo(input, context());
  await cancelled.promise;
  const result = await second;
  assert.equal(result.cached, undefined);
  assert.equal(result.info.summary, 'new lookup');
  assert.equal((await placeInfo(input, context())).cached, true);
  assert.equal(calls, 2);
});
test('a menu page first discovered by the model supplies both its image and dishes from one fetch', async t => {
  const page = 'https://late-menu.example/menu';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url));
    if (new URL(url).hostname === 'api.openai.com')
      return reply({ photoPage: page, sources: [{ url: page }] }, [
        { id: 's', type: 'web_search_call', action: { sources: [{ url: page }] } },
      ]);
    assert.equal(String(url), page);
    return new Response('<head><title>River Cafe</title><meta property="og:image" content="https://media.example/river.jpg"></head>' +
      '<script type="application/ld+json">{"@type":"MenuItem","name":"Soup"}</script>',
      { headers: { 'content-type': 'text/html' } });
  });
  const events = [];
  const { info } = await placeInfo({ city: 'London', stop: { id: 'menu-after-model', n: 'River Cafe', k: 'food' } },
    { ...context(), emit: e => events.push(e) });
  assert.equal(requests.filter(url => url === page).length, 1);
  assert.equal(info.dishes[0].name, 'Soup');
  assert.deepEqual(events.at(-1).photos, info.photos);
  assert.equal(info.photos[0].page, page);
});
test('empty photo lookups expire sooner than a successful photo lookup', async t => {
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).hostname === 'api.openai.com') { calls++; return reply({}); }
    return new Response('<title>Clock</title><meta property="og:image" content="https://media.example/clock.jpg">', { headers:{ 'content-type':'text/html' } });
  });
  const empty = { city:'London', stop:{ id:'empty-ttl', n:'No photo', k:'sight' } };
  const good = { city:'London', stop:{ id:'good-ttl', n:'Clock', k:'sight', src:{ checked:'web', url:'https://clock.example/' } } };
  await placeInfo(empty, context());
  await placeInfo(good, context());
  now += 59_000;
  assert.equal((await placeInfo(empty, context())).cached, true);
  now += 2000;
  assert.equal((await placeInfo(empty, context())).cached, undefined);
  assert.equal((await placeInfo(good, context())).cached, true);
  now += 30 * 60_000;
  assert.equal((await placeInfo(good, context())).cached, undefined);
  assert.equal(calls, 4);
});
test('limits candidate output and keeps research-only inputs internal; must picks survive restart', () => {
  const duplicate = {
    id: 'wat_umong',
    name: 'Wat Umong',
    price: 'range'.repeat(24),
    why: 'x'.repeat(220),
    tags: Array(6).fill('a'.repeat(30)),
    query: 'วัดอุโมงค์',
    aliases: ['Temple'],
    photoPage: 'https://restaurant.example/',
    src: { checked: 'web', url: 'https://invalid.example/' },
  };
  const raw = [
    {
      kind: 'bad',
      options: [
        { name: ' ' },
        duplicate,
        { ...duplicate, src: { checked: 'web', url: 'https://ok.example/' } },
        { ...duplicate, name: 'Wat Other', query: 'Wat Other' },
      ],
    },
    { kind: 'food', options: [] },
  ];
  const [q] = normalizeQuestions(
    { verified: new Set(['https://ok.example/']), value: { questions: raw } },
    3,
  );
  assert.equal(q.kind, 'sight');
  assert.ok(q.title);
  assert.equal(q.options.length, 2);
  const [a, b] = q.options;
  assert.equal(a.option.id, 'c3_wat_umong');
  assert.notEqual(b.option.id, a.option.id);
  assert.equal(a.option.src.checked, 'web');
  assert.equal(b.option.src, undefined);
  assert.equal(a.option.tags.length, 4);
  assert.equal(a.option.tags[0].length, 24);
  assert.equal(a.option.price, duplicate.price);
  assert.equal(a.option.why.length, 200);
  const picks = resolvePicks({ must: [{ id: 'gone', name: 'Wat Umong', ll: [18, 99] }], avoid: ['gone'] });
  assert.ok(matchesPick({ ll: [18.0001, 99] }, picks.must[0]));
  assert.equal(matchesPick({ ll: [18.0001, 99] }, picks.must[0], false), false);
  assert.equal(picks.avoid[0].name, 'gone');
});
test('candidate discovery uses verified search URLs, a matched preview and remembered geo coordinates', async (t) => {
  const city = 'ดานัง';
  const setup = normalize({
    city,
    startDate: '2026-11-23',
    days: 1,
    members: [{ name: 'A', avoid: 'กุ้ง' }],
    picks: { must: [{ name: 'do-not-send' }] },
  });
  const source = 'https://river.example/pho';
  const place = 'River Noodles';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.openai.com') {
      const body = JSON.parse(init.body);
      requests.push(body);
      return reply(
        {
          questions: [
            {
              kind: 'food',
              options: [
                {
                  id: 'pho',
                  name: place,
                  query: place,
                  aliases: ['River restaurant'],
                  src: { checked: 'web', url: source },
                  photoPage: source,
                },
              ],
            },
          ],
        },
        [{ type: 'web_search_call', id: 's', action: { sources: [{ url: source }] } }],
      );
    }
    if (url.hostname.includes('photon'))
      return Response.json({
        features: [
          { properties: { name: place, osm_key: 'amenity' }, geometry: { coordinates: [108.219, 16.06] } },
        ],
      });
    if (url.hostname === 'river.example')
      return new Response(
        '<head><title>River Noodles Menu</title><meta property="og:image" content="https://cdn.example/pho.jpg"></head>',
        { headers: { 'content-type': 'text/html' } },
      );
    throw new Error('Unexpected URL ' + url.href);
  });
  let summary;
  const result = await candidates(setup, { ...context(), step: (s) => (summary = s) });
  const option = result.questions[0].options[0];
  assert.deepEqual(requests.map(call => call.max_tool_calls), [2, 1, 2]);
  assert.ok(!requests[0].input[0].content.includes('do-not-send'));
  assert.ok(requests[0].input[0].content.includes('กุ้ง'));
  assert.equal(option.photo.match, 'likely');
  assert.equal(option.src.url, source);
  assert.equal(option.query, undefined);
  assert.equal(option.photoPage, undefined);
  assert.equal(option.aliases, undefined);
  assert.match(summary, /ได้ 1 คำถาม · 1 ตัวเลือก · มีรูป 1/);
  assert.deepEqual(option.ll, [16.06, 108.219]);
  const picks = resolvePicks({ must: [{ ...option, ll: [16.07, 108.22] }], avoid: [option.id] });
  assert.deepEqual(picks.must[0].ll, [16.07, 108.22]);
  assert.deepEqual(picks.avoid[0].ll, option.ll);
  assert.equal(picks.avoid[0].query, place);
});
test('Commons exact match requires name and distance, uses P18 and credited file metadata', async (t) => {
  const { exactPhoto } = await import('../server/photos.mjs?case=wikidata');
  const hit = {
    title: 'Broader article',
    pageprops: { wikibase_item: 'Q100' },
    coordinates: [{ lat: 18.8, lon: 99 }],
  };
  const file = {
    title: 'File:Wat Actual.jpg',
    imageinfo: [
      {
        url: 'https://upload.wikimedia.org/temple.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Wat_Actual.jpg',
        extmetadata: { Artist: { value: '<b>Artist</b>' }, LicenseShortName: { value: 'CC BY 4.0' } },
      },
    ],
  };
  let fileCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname.includes('wikipedia.org')) return Response.json({ query: { pages: [hit] } });
    if (url.hostname.includes('wikidata.org'))
      return Response.json({
        entities: {
          Q100: {
            aliases: { th: [{ value: 'วัดตัวอย่าง' }] },
            claims: { P18: [{ mainsnak: { datavalue: { value: 'Wat Actual.jpg' } } }] },
          },
        },
      });
    fileCalls++;
    return Response.json({ query: { pages: [file] } });
  });
  assert.equal(await exactPhoto({ n: 'Only related', ll: [18.8, 99] }, signal()), null);
  assert.equal(fileCalls, 0);
  assert.equal(await exactPhoto({ n: 'วัดตัวอย่าง', ll: [17, 99] }, signal()), null);
  assert.equal(fileCalls, 0);
  const image = await exactPhoto({ n: 'วัดตัวอย่าง', ll: [18.8, 99] }, signal());
  assert.equal(image.match, 'exact');
  assert.equal(image.credit, 'Artist · CC BY 4.0 · Wikimedia Commons');
  assert.equal(image.thumb, 'https://upload.wikimedia.org/thumb.jpg');
  assert.equal(image.url, 'https://upload.wikimedia.org/temple.jpg');
  assert.equal(fileCalls, 1);
});
test('persistent Wikimedia 429 retries once then holds further file lookups', async (t) => {
  const { exactPhoto, nearbyPhoto } = await import('../server/photos.mjs?case=wikimedia429');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 429 });
  });
  const stop = { n: 'Research Place', ll: [18.8, 99] };
  assert.equal(await exactPhoto(stop, signal()), null);
  assert.equal(calls, 2);
  assert.equal(await nearbyPhoto(stop, signal()), null);
  assert.equal(calls, 2);
  assert.equal(await exactPhoto({ n: 'Other Place', ll: null }, signal()), null);
  assert.equal(calls, 2);
});

test('tops up sparse London choices once, with distinct supported places and appropriate trip categories', async (t) => {
  const places = {
    food: ['Dishoom Covent Garden', 'Padella Borough', 'St John Smithfield', 'Brat Shoreditch'],
    sight: ['Tate Modern', 'National Gallery', 'British Museum', 'Tower of London'],
    stay: ['Waterloo Example Hotel', 'South Bank Example Inn', 'Waterloo Riverside Hotel', 'Waterloo Station Hotel'],
  };
  const href = name => 'https://venues.example/' + encodeURIComponent(name);
  const option = name => ({ name, query: name, photoPage: href(name), src: { url: href(name), checked: 'web' } });
  const group = (kind, names) => ({ kind, options: names.map((name, i) => ({
    ...option(name), ...(kind === 'stay' && {
      kind: 'hotel', address: (10 + i) + ' Test Road, Waterloo, London', ll: [51.503 + i / 1000, -.11],
      priceNight: i ? 0 : 3500,
    }),
  })) });
  let rounds, mode;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.openai.com') {
      const body = JSON.parse(init.body);
      const data = JSON.parse(body.input[0].content.split('ข้อมูล JSON:\n')[1]);
      assert.equal(body.text.format.name, 'bop_candidates');
      rounds.push({ data, budget: body.max_tool_calls, tokens: body.max_output_tokens });
      const kinds = data.categories;
      const full = mode === 'full';
      if (data.gaps && mode === 'fail') return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
      let questions;
      if (data.gaps) {
        questions = kinds.map(kind => group(kind, [...places[kind], 'Invented option'])).reverse();
        questions.push(group('stay', ['Hotel nobody requested']));
      } else {
        questions = kinds.map(kind => group(kind, full ? places[kind] : places[kind].slice(0, kind === 'food' ? 2 : 1))).reverse();
        if (!kinds.includes('stay')) questions.push(group('stay', ['Hotel nobody requested']));
      }
      const records = Object.values(places).flat().map(name => ({ url: href(name) }));
      return reply({ questions }, [{ id: 'search', type: 'web_search_call', action: { sources: records } }]);
    }
    if (url.hostname === 'venues.example') {
      return new Response('<title>' + decodeURIComponent(url.pathname.slice(1)) + '</title><meta property="og:image" content="https://media.example/venue.jpg">', { headers: { 'content-type':'text/html' } });
    }
    if (url.hostname.includes('photon')) return Response.json({ features: [{
      properties: { name: url.searchParams.get('q').replace(/ London$/, ''), osm_key: 'amenity' },
      geometry: { coordinates: [-0.1,51.5] },
    }] });
    throw Error('Unexpected request: ' + url);
  });
  const base = { city: 'London', cityLL: [51.5,-0.1], country:'GB', hotelArea: 'Waterloo', startDate:'2026-11-22', members:[{ name:'A', avoid:'กุ้ง' }] };
  for (const [days, stay, expected] of [
    [1, {mode:'auto'}, ['food','sight']],
    [5, {mode:'auto'}, ['stay','food','sight']],
    [5, {mode:'booked', name:'A Booked Hotel'}, ['food','sight']],
    [5, {stays:[{name:'First Booked Hotel',nights:2},{name:'Next Booked Hotel',nights:2}]}, ['food','sight']],
  ]) {
    mode = 'sparse'; rounds = [];
    const result = await candidates(normalize({ ...base, days, stay }), context());
    const first = rounds.slice(0, -1), followup = rounds.at(-1);
    assert.deepEqual(first.map(round => round.data.categories), expected.map(kind => [kind]));
    assert.equal(first.reduce((sum, round) => sum + round.budget, 0), 3);
    assert.equal(first.reduce((sum, round) => sum + round.tokens, 0), 8000);
    assert.equal(followup.budget, 2);
    assert.deepEqual(followup.data.gaps.map(g => g.needed), expected.map(k => k === 'food' ? 2 : 3));
    assert.ok(followup.data.existing.includes(places.food[0]));
    assert.equal(followup.data.restrictions[0].avoid, 'กุ้ง');
    assert.deepEqual(result.questions.map(q => q.kind), expected);
    const all = result.questions.flatMap(q => q.options);
    assert.equal(new Set(all.map(o => o.id)).size, all.length);
    for (const q of result.questions) {
      assert.deepEqual(q.options.map(o => o.name), places[q.kind]);
      assert.ok(q.options.every(o => o.src.checked === 'web' && o.photo.credit));
      if (q.kind === 'stay') {
        assert.equal(q.multi, false);
        assert.ok(q.options.every(o => o.kind === 'hotel' && o.query.includes(o.address) && o.surveyRef && o.ll.length === 2));
        assert.equal(q.options[0].priceNight, 3500);
        assert.equal(q.options[1].priceNight, null);
        // A second worker can restore server-issued evidence and pricing even if the browser alters the pick.
        const { resolveSurveyPicks } = await import('../server/candidates.mjs?case=cold-hotel-worker');
        const pick = q.options[0];
        const restored = await resolveSurveyPicks({ ...base, days, picks: { must: [{...pick, priceNight:1, ll:[0,0], src:{checked:'web',url:'https://wrong.example/'} }] } });
        assert.equal(restored.must[0].priceNight, 3500);
        assert.deepEqual(restored.must[0].ll, pick.ll);
        assert.equal(restored.must[0].src.url, pick.src.url);
        const warm = await import('../server/candidates.mjs');
        const otherDates = await warm.resolveSurveyPicks({...base, days, startDate:'2026-11-25', picks:{must:[pick]}});
        assert.equal(otherDates.must[0].src, undefined);
        assert.equal(otherDates.must[0].priceNight, undefined);
        const later = Date.now() + 3 * 3600 * 1000;
        const clock = t.mock.method(Date, 'now', () => later);
        try {
          const expired = await warm.resolveSurveyPicks({...base, days, picks:{must:[pick]}});
          assert.equal(expired.must[0].src, undefined);
        } finally { clock.mock.restore(); }
      }
    }
  }
  for (const scenario of ['full','fail']) {
    mode = scenario; rounds = [];
    const { questions } = await candidates(normalize({ ...base, days: 1 }), context());
    assert.equal(rounds.length, mode === 'full' ? 2 : 3);
    assert.deepEqual(questions.map(q => q.options.length), mode === 'full' ? [4,4] : [2,1]);
  }
  const setup = normalize({ ...base, days: 1 });
  mode = 'full';
  rounds = [];
  const exclude = ['The Dishoom Covent Garden', 'Padella Borough'];
  const refreshed = await candidates(setup, context(), { kind: 'food', exclude });
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].data.categories, ['food']);
  assert.deepEqual(rounds[0].data.existing, exclude);
  assert.deepEqual(refreshed.questions.map(q => q.kind), ['food']);
  assert.deepEqual(refreshed.questions[0].options.map(o => o.name), places.food.slice(2));
  assert.ok(refreshed.questions[0].options.every(o => o.src?.checked === 'web'));
  const reusedId = refreshed.questions[0].options[0].id;
  const elsewhere = { id: reusedId, name: 'A different restaurant', kind: 'food' };
  const picks = resolvePicks({ must: [elsewhere], avoid: [elsewhere] });
  assert.equal(picks.must[0].query, elsewhere.name);
  assert.equal(picks.must[0].ll, undefined);
  assert.equal(picks.avoid[0].name, elsewhere.name);
  const exhausted = await candidates(setup, context(), { kind: 'food', exclude: places.food });
  assert.deepEqual(exhausted.questions, []);
  await assert.rejects(candidates(setup, context(), { kind: 'stay', exclude: [] }), /เลือกหมวด/);
  rounds = [];
  const hotels = await candidates(normalize({ ...base, days: 3 }), context(), { kind:'stay', exclude:places.stay.slice(0,2) });
  assert.deepEqual(rounds[0].data.categories,['stay']);
  assert.equal(rounds[0].data.setup.hotelArea,'Waterloo');
  assert.deepEqual(hotels.questions[0].options.map(o => o.name), places.stay.slice(2));
  assert.ok(hotels.questions[0].options.every(o => o.kind === 'hotel'));
});

test('a hotel question removes neighborhoods, generic lodging and hotels without a checked branch source', () => {
  const src = { url:'https://lodging.example/waterloo', checked:'web' };
  const property = {kind:'hotel',name:'Waterloo Example Hotel',address:'18 Test Road, Waterloo, London',ll:[51.50,-0.11],src};
  const [question] = normalizeQuestions({ verified: new Set([src.url]), value:{questions:[{kind:'stay',options:[
    {name:'Bloomsbury',query:'Bloomsbury, London',src}, {...property,name:'Waterloo'}, {...property,name:'Hotel'},
    {...property,name:'Hotel near Waterloo'}, {...property,address:'',query:''},
    {...property,name:'Unverified Hotel',src:{...src,url:'https://invented.example/'}}, property,
  ]}]} },1,new Set(),{city:'London',hotelArea:'Waterloo'});
  assert.deepEqual(question.options.map(entry => entry.option.name),[property.name]);
  assert.equal(question.options[0].stop.k,'hotel');
});
