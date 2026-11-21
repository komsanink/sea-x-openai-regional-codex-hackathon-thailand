export { matchesPick } from './pick-match.mjs';
import { bad, coordinates } from './domain.mjs';
import { findCity, findPlace, findSavedVenue } from './geo.mjs';
import { hotelOptions, isHotelCandidate } from './lodging.mjs';
import { model, provider } from './model.mjs';
import { operationalStore } from './operation-store.mjs';
import { catalogPlace } from './sample.mjs';
import { containsName, exactPhoto, hotelPageDetails, namesVenue, nearbyPhoto, pagePhoto, publicPage, readPublicDocument } from './photos.mjs';
import { boundedStrings, httpsUrl, list, placeText, sourceIdentity } from './place-text.mjs';

const memory = new Map();
let run = 0;

const prompt =
  'ช่วยกลุ่มเปรียบเทียบสถานที่จริงในเมืองนี้ ถามเป็นภาษาไทยหนึ่งคำถามต่อหมวดที่ระบุใน categories เป้าหมาย 4 ตัวเลือกที่แตกต่างกันต่อคำถาม ให้ได้ถึง 6 ถ้ามีที่เหมาะจริง ' +
  'จำนวนนี้เป็นทางเลือกให้พิจารณา แม้ทริปวันเดียวก็เสนอหลายร้านและหลายที่เที่ยวได้ เลือกให้ต่างกันทั้งประสบการณ์ ย่าน หรือราคา และให้เข้ากับเวลา งบ การเดินและสิ่งที่สมาชิกสนใจ หลีกเลี่ยงการเสนอจุดเดิมซ้ำต่างชื่อ ' +
  'ใช้ผลค้นที่ระบุสถานที่จริง เช่น บทความที่รวบรวมหลายสถานที่หรือหน้าเว็บไซต์ของแต่ละแห่ง หากยืนยันไม่ได้หรือหมวดนั้นขัดกับคำขอให้ส่งเท่าที่เหมาะ ห้ามสร้างชื่อ ราคา หรือลิงก์เพื่อให้ครบจำนวน ' +
  'บอกข้อดี tags ราคาต่อคนแบบสั้น เช่น £20–30 ต่อคน พิกัด query และ aliases สำหรับหา POI, photoPage หน้าเว็บที่มีรูปของสถานที่หรือย่านนี้ ' +
  'ร้านอาหารระบุเมนูที่เหมาะกับข้อจำกัดอาหารของสมาชิกแต่ละคนตามหลักฐาน ถ้ายืนยันไม่ได้ให้บอกตรง ๆ ไม่รับรองความปลอดภัยของอาหาร ใส่ src.checked=web กับ URL ผลค้นที่อ้างได้ ' +
  'ถ้ามีหมวด stay ให้เสนอเฉพาะโรงแรมจริงเป็นรายแห่ง kind=hotel ใน setup.hotelArea ที่ผู้ใช้เลือก หรือย่านที่เดินทางสะดวกในเมืองเมื่อไม่ได้ระบุย่าน ' +
  'ใช้ชื่อโรงแรมพร้อมสาขา ที่อยู่จริงใน address, query เป็นชื่อโรงแรมและที่อยู่, ll พิกัดตัวอาคาร และ src เป็นหน้าอ้างอิงที่ระบุชื่อสาขา ' +
  'ห้ามส่งชื่อย่าน สถานี หรือจุดกึ่งกลางเมืองแทนโรงแรม ใส่ priceNight เป็นราคาประมาณบาทต่อห้องต่อคืนที่มีหลักฐาน หรือ 0 เมื่อไม่ทราบ ห้ามอ้างว่าจองแล้วหรือมีห้องว่าง';

export function resolvePicks(input = {}) {
  const must = list(input?.must)
    .filter((pick) => pick && typeof pick === 'object' && placeText(pick.name))
    .slice(0, 15)
    .map((pick) => {
      const cached = memory.get(pick.id);
      const saved = cached?.kind !== 'hotel' && cached?.name === placeText(pick.name) ? cached : undefined;
      const hotel = pick.kind === 'hotel';
      return {
        id: placeText(pick.id, 200),
        name: placeText(pick.name),
        query: placeText(pick.query, 300) || saved?.query || placeText(pick.name),
        kind: placeText(pick.kind, 20) || saved?.kind,
        ll: coordinates(pick.ll) ? pick.ll : saved?.ll,
        ...(hotel && {
          address: placeText(pick.address, 300),
          surveyRef: placeText(pick.surveyRef, 36),
        }),
      };
    });
  const avoid = list(input?.avoid)
    .slice(0, 30)
    .map((pick) => {
      const id = placeText(typeof pick === 'string' ? pick : pick?.id, 200);
      const name = placeText(pick?.name);
      const saved = memory.get(id);
      if (name) return { id, name, query: placeText(pick.query, 300) || (saved?.name === name ? saved.query : name),
        ...(pick.kind === 'hotel' || saved?.kind === 'hotel' && saved.name === name ? { kind: 'hotel' } : {}) };
      return saved || { id, name: id, query: placeText(pick?.query) };
    })
    .filter((p) => p.name);
  return { must, avoid };
}
const hotelScope = setup => JSON.stringify([setup.city, setup.hotelArea || '', setup.startDate, setup.days]);
export async function resolveSurveyPicks(setup) {
  const picks = resolvePicks(setup.picks);
  for (const [index, pick] of picks.must.entries()) {
    if (pick.kind !== 'hotel' || !pick.surveyRef) continue;
    const saved = await operationalStore.readSurveyHotel(pick.surveyRef, hotelScope(setup), pick.id);
    if (saved?.name === pick.name) picks.must[index] = { ...saved, surveyRef: pick.surveyRef };
  }
  return picks;
}
const titles = { sight: 'อยากไปเที่ยวที่ไหนบ้าง', food: 'สนใจร้านอาหารไหนบ้าง', stay: 'อยากพักโรงแรมไหน' };
const priceWords = new Intl.Segmenter('th', { granularity: 'word' });
function priceHint(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : placeText(value, 1600);
  if (text.length <= 240) return text;
  let end = 0;
  for (const { segment, index } of priceWords.segment(text)) {
    if (index + segment.length > 239) break;
    end = index + segment.length;
  }
  return text.slice(0, end || 239).trimEnd() + '…';
}
const comparable = value => placeText(value).normalize('NFKC').toLowerCase()
  .replace(/^the\s+/i, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
function sameVenue(a, b) {
  const names = [comparable(a.option.name), comparable(a.stop.query)];
  return [comparable(b.option.name), comparable(b.stop.query)].some(name => name && names.includes(name));
}
function addDistinct(options, entry) {
  const previous = options.find(item => sameVenue(item, entry));
  if (previous) {
    if (!previous.option.src && entry.option.src) {
      previous.option.src = entry.option.src;
      previous.photoPage ||= entry.photoPage;
    }
  } else if (options.length < 6) options.push(entry);
}
export function normalizeQuestions(result, runId, ids = new Set(), setup) {
  const verified = new Set([...(result.verified || []), ...(result.cited || [])].map(sourceIdentity).filter(Boolean));
  return list(result.value.questions)
    .slice(0, 3)
    .flatMap((q, i) => {
      const kind = ['food', 'sight', 'stay'].includes(q?.kind) ? q.kind : 'sight';
      const entries = list(q?.options)
        .filter((item) => placeText(item?.name))
        .slice(0, 24)
        .flatMap((item) => {
          const name = placeText(item.name);
          const hotel = kind === 'stay';
          const query = placeText(item.query, 300);
          const address = placeText(item.address, 300) || (hotel ? query.split(',').slice(1).join(',').trim() : '');
          if (hotel && (!isHotelCandidate(item, setup) || !address || comparable(address) === comparable(name))) return [];
          const slug =
            (placeText(item.id) || name)
              .normalize('NFKC')
              .toLowerCase()
              .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 80) || 'place';
          let id = 'c' + runId + '_' + slug;
          while (ids.has(id)) id += '_';
          ids.add(id);
          const raw = item.src;
          const url = httpsUrl(raw?.url || (typeof raw === 'string' ? raw : ''));
          const src =
            (raw?.checked ?? item.checked) === 'web' && verified.has(sourceIdentity(url))
              ? { url, title: placeText(raw?.title) || new URL(url).hostname, checked: 'web' }
              : undefined;
          if (hotel && !src) return [];
          const night = Number(item.priceNight);
          const price = hotel ? '' : priceHint(item.price);
          const venueQuery = hotel ? (query.includes(',') ? query : name + ', ' + address) : (query || name);
          const option = {
            id,
            name,
            why: placeText(item.why, 200),
            tags: boundedStrings(item.tags, 4, 24),
            ...(price ? { price } : {}),
            ...(src ? { src } : {}),
            ...(hotel && { kind: 'hotel', address, query: venueQuery, priceNight: night > 0 && Number.isFinite(night) ? night : null }),
          };
          const stop = {
            n: name,
            k: hotel ? 'hotel' : kind,
            query: venueQuery,
            aliases: boundedStrings(item.aliases, 8, 80),
            ll: coordinates(item.ll) ? item.ll : undefined,
          };
          return { option, stop, catalogId: item.catalogId, photoPage: publicPage(item.photoPage) };
        });
      const options = [];
      for (const entry of entries) addDistinct(options, entry);
      return options.length
        ? [{ id: 'q' + (i + 1), kind, title: kind === 'stay' ? titles.stay : placeText(q.title) || titles[kind], multi: kind !== 'stay', options }]
        : [];
    });
}
function combineQuestions(questions, incoming, allowed, requireSource = false) {
  for (const question of incoming) {
    if (!allowed.includes(question.kind)) continue;
    let target = questions.find(item => item.kind === question.kind);
    if (!target) {
      target = { ...question, id: 'q' + (questions.length + 1), options: [] };
      questions.push(target);
    }
    for (const entry of question.options) {
      if (requireSource && !entry.option.src) continue;
      const elsewhere = questions.some(other => other !== target && other.options.some(item => sameVenue(item, entry)));
      if (!elsewhere) addDistinct(target.options, entry);
    }
  }
}
async function confirmSurveyHotels(questions, setup, ctx, batch) {
  for (const question of questions) {
    if (question.kind !== 'stay') continue;
    await group(question.options, 4, entry => locateSurveyHotel(entry, setup, ctx, batch));
    question.options = question.options.filter(({option}) => coordinates(option.ll));
  }
}
async function discoverQuestions(discovery, restrictions, ctx, refresh, batch) {
  const categories = discovery.days > 1 && discovery.stay?.mode !== 'booked'
    ? ['stay', 'food', 'sight'] : ['food', 'sight'];
  const input = { setup: discovery, restrictions, categories };
  if (refresh !== undefined) {
    if (!refresh || !categories.includes(refresh.kind) || !Array.isArray(refresh.exclude))
      throw bad('เลือกหมวดที่ต้องการหาสถานที่เพิ่มอีกครั้ง');
    const existing = [...new Set(refresh.exclude.map(value => placeText(value, 200)).filter(Boolean))];
    const seen = new Set(existing.map(comparable));
    const more = await model(prompt + ' หาตัวเลือกใหม่ในหมวดที่ขอเท่านั้น ห้ามซ้ำกับรายชื่อ existing รวมทั้งชื่อเรียกอีกแบบของสถานที่เดิม ถ้าไม่มีข้อมูลยืนยันให้เว้น', {
      ...input, categories: [refresh.kind], existing: existing.slice(-120),
    }, { ...ctx, operation: 'candidates', searches: 3 });
    const questions = normalizeQuestions(more, ++run, new Set(), discovery);
    for (const question of questions) {
      question.options = question.options.filter(({ option, stop }) =>
        ![option.name, stop.query, ...stop.aliases].some(name => seen.has(comparable(name))));
    }
    const fresh = [];
    combineQuestions(fresh, questions, [refresh.kind], true);
    await confirmSurveyHotels(fresh, discovery, ctx, batch);
    return fresh.filter(question => question.options.length);
  }
  // API providers enforce search and output limits per response. Split the same
  // initial budget across the relevant categories. The CLI has only a turn limit.
  const jobs = ['openai', 'anthropic'].includes(provider) ? categories.map(kind => [kind]) : [categories];
  const share = (total, index) => Math.floor(total / jobs.length) + Number(index < total % jobs.length);
  const runId = ++run;
  const ids = new Set();
  const rounds = await Promise.allSettled(jobs.map(async (kinds, index) => {
    const result = await model(prompt, { ...input, categories: kinds }, {
      ...ctx, operation: 'candidates', searches: share(3, index), maxOutputTokens: share(8000, index),
    });
    const found = [];
    combineQuestions(found, normalizeQuestions(result, runId, ids, discovery), kinds);
    await confirmSurveyHotels(found, discovery, ctx, batch);
    return found;
  }));
  ctx.signal.throwIfAborted();
  if (rounds.every(round => round.status === 'rejected')) throw rounds[0].reason;
  const questions = [];
  for (const round of rounds) if (round.status === 'fulfilled') combineQuestions(questions, round.value, categories);
  const target = 4;
  const gaps = categories.map(kind => {
    const found = questions.find(q => q.kind === kind)?.options.length || 0;
    return { kind, needed: target - found };
  }).filter(gap => gap.needed > 0);
  if (provider !== 'fake' && gaps.length) {
    ctx.step('กำลังค้นตัวเลือกเพิ่มเติมให้กลุ่มเปรียบเทียบ');
    const existing = questions.flatMap(q => q.options.map(entry => entry.option.name));
    const missing = gaps.map(gap => gap.kind);
    try {
      const more = await model(prompt + ' รอบนี้เติมเฉพาะหมวดและจำนวนใน gaps ไม่ต้องส่งสถานที่ใน existing ซ้ำ ทุกสถานที่ที่เพิ่มต้องมีหน้าผลค้นสนับสนุน ถ้าไม่มีให้เว้น', {
        ...input, categories: missing, gaps, existing,
      }, { ...ctx, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(50_000)]), operation: 'candidates', searches: 2 });
      const additional = [];
      combineQuestions(additional, normalizeQuestions(more, runId, ids, discovery), missing, true);
      for (const question of additional.filter(q => q.kind === 'stay'))
        question.options = question.options.filter(entry => !questions.some(q => q.options.some(old => sameVenue(old, entry))));
      await confirmSurveyHotels(additional, discovery, ctx, batch);
      combineQuestions(questions, additional, missing, true);
    } catch {
      ctx.signal.throwIfAborted();
      ctx.step('ใช้ตัวเลือกที่ค้นได้ในรอบแรก');
    }
  }
  return categories.map(kind => questions.find(q => q.kind === kind))
    .filter(q => q?.options.length).map((q, index) => ({...q, id:'q' + (index + 1)}));
}
async function group(items, width, work) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, width) }, async () => {
      while (cursor < items.length) await work(items[cursor++]);
    }),
  );
}
async function photoStage(items, width, timeout, ctx, work) {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]);
  await group(items, width, async (entry) => {
    if (signal.aborted || entry.option.photo) return;
    try {
      const photo = await work(entry, signal);
      if (!signal.aborted && photo) {
        const { url, thumb, credit, page, match } = photo;
        entry.option.photo = { url, ...(thumb ? { thumb } : {}), credit, page, match };
      }
    } catch {
      ctx.signal.throwIfAborted();
    }
  });
  ctx.signal.throwIfAborted();
}
async function firstPass(entry, signal) {
  const urls = [...new Set([entry.photoPage, entry.option.src?.url].filter(Boolean))];
  // Reserve time for a confirmed source even when Wikimedia is queued or unavailable.
  const wikiSignal = AbortSignal.any([signal, AbortSignal.timeout(6500)]);
  const [exact, ...previews] = await Promise.all([
    exactPhoto(entry.stop, wikiSignal).catch(() => null),
    ...urls.map((url) => pagePhoto(url, entry.stop, signal)),
  ]);
  signal.throwIfAborted();
  return exact || previews.find(Boolean) || null;
}
async function locateSurveyHotel(entry, setup, ctx, batch) {
  const { option, stop } = entry;
  const url = publicPage(option.src.url);
  if (!url) return;
  const venue = { name: option.name, kind: 'hotel', query: option.query };
  const [ll, doc] = await Promise.all([
    findSavedVenue(venue, stop.ll || setup.cityLL, ctx.signal, batch),
    readPublicDocument(url, ctx.signal, {headOnly:false}),
  ]);
  // A hotel-named POI or a property page must support the branch, even if a search cited a neighborhood guide.
  const title = doc?.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const identity = { name: option.name, aliases: stop.aliases.filter(alias => alias.length > 3 && alias !== setup.city && alias !== setup.hotelArea) };
  const details = doc ? hotelPageDetails(doc.text, doc.page, identity) : {};
  const identifiesProperty = details.named || namesVenue(doc?.text || '', doc?.page || url, identity) &&
    (isHotelCandidate({name: option.name}, setup) ||
      (containsName(title, identity) && /hotel|resort|hostel|โรงแรม|ที่พัก|check[ -]?in|guest rooms/i.test(doc?.text || '') &&
        !/hotels\s+(?:in|near)|โรงแรม(?:ใน|ใกล้)/i.test(title)));
  if (!ll && !identifiesProperty) return;
  const [hotel] = hotelOptions([{ ...option, ...option.src, ll: details.ll || ll || stop.ll }], setup);
  if (!hotel) return;
  option.ll = hotel.ll;
  if (details.photo) option.photo = details.photo;
}
export async function candidates(setup, ctx, refresh) {
  const started = performance.now();
  const { picks: _picks, ...discovery } = setup;
  if (!setup.cityLL || !setup.country) {
    const city = await findCity(setup.city, ctx.signal);
    discovery.cityLL ??= city?.ll;
    discovery.country ||= city?.cc;
  }
  const restrictions = setup.members.filter((m) => m.avoid).map((m) => ({ name: m.name, avoid: m.avoid }));
  ctx.step(refresh ? 'กำลังหาตัวเลือกใหม่ในหมวดนี้' : 'กำลังค้นหาสถานที่ให้สมาชิกเลือก');
  const batch = { remaining: 8 };
  const questions = await discoverQuestions(discovery, restrictions, ctx, refresh, batch);
  const items = questions.flatMap((q) => q.options);
  const hotels = items.filter(entry => entry.option.kind === 'hotel');
  const nonHotels = items.filter(entry => entry.option.kind !== 'hotel');
  const offline = provider === 'fake';
  await Promise.all([
    group(nonHotels, 4, async (entry) => {
      const hint = entry.stop.ll;
      const catalog = catalogPlace(setup.city, entry);
      const point =
        catalog?.ll ??
        (offline
          ? null
          : await findPlace(
              entry.stop.query + ' ' + setup.city,
              hint || discovery.cityLL,
              hint ? 3 : 40,
              ctx.signal,
              batch,
            ));
      if (coordinates(point ?? hint)) entry.option.ll = point ?? hint;
    }),
    offline ? undefined : photoStage(nonHotels, nonHotels.length, 15_000, ctx, firstPass),
    offline ? undefined : photoStage(hotels, hotels.length, 6500, ctx,
      (entry, signal) => exactPhoto({ ...entry.stop, ll: entry.option.ll }, signal)),
  ]);
  for (const entry of items) entry.stop.ll = entry.option.ll;
  if (!offline) {
    await photoStage(nonHotels, nonHotels.length, 10_000, ctx, (entry, signal) => nearbyPhoto(entry.stop, signal));
    await photoStage(items, 6, 60_000, ctx, async (entry, signal) => {
      const result = await model(
        'ค้นเพียงหนึ่งครั้ง หา URL หน้าเว็บที่มีรูปของสถานที่ตรงชื่อและสาขา สำหรับที่พักใช้รูปของโรงแรมสาขานั้น คืน pages เป็น URL ของหน้าที่ค้นเจอ',
        { city: discovery.city, country: discovery.country, stop: entry.stop },
        { ...ctx, signal, operation: 'pages', searches: 1 },
      );
      const urls = [
        ...new Set([
          ...list(result.value.pages)
            .map(httpsUrl)
            .filter((url) => result.verified.has(url)),
          ...result.cited,
          ...result.verified,
        ]),
      ];
      for (const url of urls.slice(0, 4)) {
        const preview = await pagePhoto(url, entry.stop, signal);
        if (preview) return preview;
      }
      return null;
    });
  }
  for (const q of questions) {
    const remembered = q.options.map(({ option, stop }) => ({
      id: option.id,
      name: option.name,
      query: stop.query,
      kind: option.kind || q.kind,
      ll: option.ll,
      ...(option.kind === 'hotel' && { address: option.address, src: option.src, priceNight: option.priceNight, why: option.why }),
    }));
    const surveyRef = q.kind === 'stay' && remembered.length
      ? await operationalStore.rememberHotelSurvey(hotelScope(discovery), remembered) : '';
    q.options = q.options.map(({ option }, i) => {
      if (surveyRef) option.surveyRef = remembered[i].surveyRef = surveyRef;
      memory.set(option.id, remembered[i]);
      return option;
    });
  }
  const shown = questions.flatMap(q => q.options);
  ctx.step(
    'ได้ ' +
      questions.length +
      ' คำถาม · ' +
      shown.length +
      ' ตัวเลือก · มีรูป ' +
      shown.filter(option => option.photo).length,
  );
  return { questions, ms: Math.round(performance.now() - started), usage: ctx.usage };
}
