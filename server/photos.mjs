import { isIP } from 'node:net';
import { publicDispatcher } from './public-fetch.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { coordinates, distance } from './domain.mjs';
import { boundedStrings, httpsUrl, placeText, rawUrl, sourceIdentity } from './place-text.mjs';

const agent = 'BopTripPlanner/1.0 (group trip planner; place media)';
const commons = 'https://commons.wikimedia.org/w/api.php';
const ignored = new Set([
  'the',
  'wat',
  'park',
  'place',
  'temple',
  'restaurant',
  'market',
  'hotel',
  'area',
  'city',
  'street',
  'photo',
  'cafe',
  'and',
  'district',
  'museum',
]);
const names = (stop) => [
  ...new Set(boundedStrings([stop.n ?? stop.name, stop.query, ...(stop.aliases ?? [])], 10, 120)),
];
const simplify = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .trim();
const words = (value) => simplify(value).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const key = (value) => words(value).join('');
const decode = (value) =>
  String(value ?? '').replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, id) => {
    if (id[0] === '#') {
      const cp = id[1].toLowerCase() === 'x' ? parseInt(id.slice(2), 16) : Number(id.slice(1));
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[id.toLowerCase()];
  });
const strip = (html) =>
  decode(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

export function publicPage(value) {
  const href = httpsUrl(value);
  if (!href) return '';
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.port ||
    !host.includes('.') ||
    isIP(host) ||
    /[:[\]]/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain|intranet|test|invalid|onion)$/.test(host) ||
    host.endsWith('.home.arpa')
  )
    return '';
  return href;
}

export function containsName(text, stop) {
  const tokens = ' ' + words(text).join(' ') + ' ';
  return names(stop).some((name) => {
    const target = words(name).join(' ');
    if (target.length < 2 || ignored.has(target)) return false;
    return (
      tokens.includes(' ' + target + ' ') ||
      (/[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff]/.test(target) && key(text).includes(key(name)))
    );
  });
}
function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  }
  return attributes;
}
function tags(head) {
  const meta = new Map();
  for (const tag of head.matchAll(/<meta\b(?:"[^"]*"|'[^']*'|[^>'"])*>/gi)) {
    const attributes = htmlAttributes(tag[0]);
    const key = (attributes.property || attributes.name || '').toLowerCase();
    if (key && !meta.has(key)) meta.set(key, attributes.content || '');
  }
  return meta;
}
function rasterPreview(value) {
  return !/\.svg(?:z)?(?:[?#/]|$)|(?:^|[/_.-])(?:logos?|icons?|favicons?|placeholders?|spacer|default[-_]image|no[-_]?image)(?:[./?&_-]|$)/i.test(
    value,
  );
}
export function namesVenue(head, page, stop) {
  const host = new URL(page).hostname.replace(/^www\./i, '').split('.')[0];
  let path = new URL(page).pathname;
  try { path = decodeURIComponent(path); } catch { /* Retain literal path. */ }
  const meta = tags(head);
  const title = strip(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  return [title, meta.get('og:title'), path, host + ' ' + path].some((value) => containsName(value, stop));
}
export function previewFromHead(head, page, stop) {
  page = publicPage(page);
  if (!page || !namesVenue(head, page, stop)) return null;
  const meta = tags(head);
  const raw = rawUrl(meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('twitter:image') || '');
  if (!raw) return null;
  let url;
  try {
    url = publicPage(new URL(raw, page).href);
  } catch {
    return null;
  }
  if (!url || !rasterPreview(url) || /svg/i.test(meta.get('og:image:type') || '')) return null;
  if (
    ['og:image:width', 'og:image:height'].some(
      (k) => meta.has(k) && Number(meta.get(k)) > 0 && Number(meta.get(k)) < 300,
    )
  )
    return null;
  return {
    url,
    page,
    credit: placeText(meta.get('og:site_name'), 120) || new URL(page).hostname,
    source: 'web',
    match: 'likely',
  };
}
function hotelImageUrl(raw, page) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const url = publicPage(new URL(raw, page).href);
    const asset = decodeURIComponent(url);
    if (url && rasterPreview(asset) &&
        !/(?:[/_.-])(?:og[-_]?image|social[-_]?(?:card|share)|facebook-twitter)(?:[./?&_-]|$)/i.test(asset)) return url;
  } catch { /* Ignore unusable media entries. */ }
  return '';
}
// A directory can describe several hotels. Use structured facts and images only from the named property.
export function hotelPageDetails(html, page, identity) {
  page = publicPage(page);
  if (!page) return {};
  let property;
  for (const script of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const roots = [JSON.parse(script[1])].flat();
      const entities = roots.flatMap(root => [root, root?.['@graph'] ?? [], root?.mainEntity ?? []].flat());
      property = entities.find(node => [node?.['@type']].flat().some(type => /(?:^|\/)(?:Hotel|Hostel|Resort|Motel|LodgingBusiness|BedAndBreakfast)$/i.test(type)) &&
        containsName(node.name, identity));
      if (property) break;
    } catch { /* Another script can contain a usable property. */ }
  }
  const images = [];
  for (const tag of html.matchAll(/<img\b(?:"[^"]*"|'[^']*'|[^>'"])*>/gi)) {
    const attrs = htmlAttributes(tag[0]);
    if (containsName(attrs.alt, identity)) images.push(attrs['data-src'], attrs.src);
  }
  for (const item of [property?.image].flat()) images.push(typeof item === 'string' ? item : item?.contentUrl || item?.url);
  const head = html.split(/<\/head\s*>/i, 1)[0];
  const fallback = previewFromHead(head, page, identity);
  images.push(fallback?.url);
  const url = images.map(raw => hotelImageUrl(raw, page)).find(Boolean);
  const photo = url && { url, page, match:'likely', source:'web', credit:placeText(tags(head).get('og:site_name')) || new URL(page).hostname };
  const geo = property?.geo;
  const ll = geo?.latitude != null && geo.longitude != null ? [Number(geo.latitude), Number(geo.longitude)] : null;
  return { named: Boolean(property), ...(coordinates(ll) && {ll}), ...(photo && {photo}) };
}
// A restaurant menu and its preview can consume the same response during one lookup.
const fullDocuments = new WeakMap();
export function readPublicDocument(value, signal, options = {}) {
  if (options.headOnly !== false || options.json) return fetchDocument(value, signal, options);
  let reads = fullDocuments.get(signal);
  if (!reads) {
    reads = new Map();
    fullDocuments.set(signal, reads);
  }
  const key = JSON.stringify([sourceIdentity(value), options.limit]);
  let read = reads.get(key);
  if (!read) {
    const head = Promise.withResolvers();
    const body = fetchDocument(value, signal, {
      ...options, onHead: (text, page) => head.resolve({ text, page }),
    }).finally(() => head.resolve(null));
    read = { body, head: head.promise };
    reads.set(key, read);
  }
  if (!options.onHead) return read.body;
  const preview = read.head.then(doc => { if (doc) options.onHead(doc.text, doc.page); });
  return Promise.all([read.body, preview]).then(([document]) => document);
}

async function fetchDocument(value, signal, { headOnly = true, limit = 300_000, json = false, onHead } = {}) {
  let page = publicPage(value);
  if (!page) return null;
  const timed = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(page, {
        dispatcher: publicDispatcher,
        redirect: 'manual',
        signal: timed,
        headers: { 'user-agent': agent, accept: 'text/html,application/xhtml+xml' },
      });
      const final = publicPage(response.url || page);
      if (!final) {
        await response.body?.cancel();
        return null;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || !(page = publicPage(new URL(location, final).href))) return null;
        continue;
      }
      const type = response.headers.get('content-type');
      if (!response.ok || (type && !/html/i.test(type) && !(json && /json/i.test(type)))) {
        await response.body?.cancel();
        return null;
      }
      if (!response.body) return null;
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let head = '';
      try {
        while (head.length < limit && !(headOnly && /<\/head\s*>/i.test(head))) {
          const next = await reader.read();
          if (next.done) {
            head += decoder.decode();
            break;
          }
          head += decoder.decode(next.value, { stream: true }).slice(0, limit - head.length);
          if (onHead && (/<\/head\s*>/i.test(head) || head.length >= 300_000)) {
            onHead(head.slice(0, 300_000).split(/<\/head\s*>/i)[0], final);
            onHead = null;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (onHead) onHead(head.slice(0, 300_000).split(/<\/head\s*>/i)[0], final);
      return { text: headOnly ? head.split(/<\/head\s*>/i)[0] : head, page: final };
    }
  } catch {
    signal.throwIfAborted();
  }
  return null;
}

export async function pagePhoto(value, stop, signal) {
  const hotel = (stop.kind || stop.k) === 'hotel';
  const document = await readPublicDocument(value, signal, {headOnly: !hotel});
  if (!document) return null;
  return hotel ? hotelPageDetails(document.text, document.page, stop).photo || null : previewFromHead(document.text, document.page, stop);
}

let nextStart = 0,
  active = 0,
  blockedUntil = 0;
const waiting = new Set();
const cache = new Map();
async function wikiRequest(url, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() < blockedUntil) return { status: 0 };
    if (active >= 2) {
      await new Promise((resolve, reject) => {
        const abort = () => {
          waiting.delete(ready);
          reject(signal.reason);
        };
        const ready = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        waiting.add(ready);
      });
      continue;
    }
    if (Date.now() < nextStart) {
      await delay(nextStart - Date.now(), undefined, { signal });
      continue;
    }
    nextStart = Date.now() + 250;
    active++;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': agent },
        signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
      });
      if (res.ok) return { status: res.status, data: await res.json() };
      await res.body?.cancel();
      return { status: res.status };
    } finally {
      active--;
      for (const ready of waiting) ready();
      waiting.clear();
    }
  }
}
async function wiki(host, params, signal) {
  if (Date.now() < blockedUntil) return null;
  const url = new URL(host);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  if (cache.has(url.href)) return cache.get(url.href);
  try {
    let reply = await wikiRequest(url, signal);
    if (reply.status === 429) {
      reply = await wikiRequest(url, signal);
      if (reply.status === 429) blockedUntil = Date.now() + 60_000;
    }
    if (reply.data) {
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(url.href, reply.data);
    }
    return reply.data;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}
const pages = (result) => Object.values(result?.query?.pages ?? {});
const imageArgs = { prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '720' };
const rasterFile = (title) => /\.(?:jpe?g|png|webp|tiff?|gif)$/i.test(title ?? '') && rasterPreview(title);
function commonsPhoto(page, match) {
  const info = page?.imageinfo?.[0];
  if (!info || !rasterFile(page.title) || /svg/i.test(info.mime ?? '')) return null;
  const url = httpsUrl(info.url) || httpsUrl(info.thumburl);
  const filePage = httpsUrl(
    info.descriptionurl ||
      'https://commons.wikimedia.org/wiki/' + encodeURIComponent(page.title.replaceAll(' ', '_')),
  );
  if (!url || !filePage) return null;
  const data = info.extmetadata;
  const artist = strip(data?.Artist?.value).slice(0, 150) || 'ไม่ทราบชื่อช่างภาพ';
  const licence = strip(data?.LicenseShortName?.value || data?.UsageTerms?.value);
  return {
    url,
    thumb: httpsUrl(info.thumburl) || undefined,
    page: filePage,
    source: 'wikimedia',
    match,
    credit: [artist, licence, 'Wikimedia Commons'].filter(Boolean).join(' · '),
  };
}
function coordFrom(entity, page) {
  const coord = page.coordinates?.[0];
  if (coord) return [coord.lat, coord.lon];
  const point = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  return point ? [point.latitude, point.longitude] : null;
}
export async function exactPhoto(stop, signal) {
  const aliases = names(stop);
  if (!coordinates(stop.ll) || !aliases.length) return null;
  const lang = /[\u0e00-\u0e7f]/.test(aliases.join('')) ? 'th' : 'en';
  const limit = ['sight', 'nature', 'market', 'area', 'stay'].includes(stop.k) ? 3 : 1.5;
  const keys = new Set(aliases.map(key));
  const seen = new Set();
  for (const code of new Set([lang, 'en'])) {
    const host = 'https://' + code + '.wikipedia.org/w/api.php';
    for (const query of [
      { titles: aliases.join('|') },
      { generator: 'search', gsrsearch: stop.query || aliases[0], gsrlimit: '4' },
    ]) {
      const articles = pages(
        await wiki(
          host,
          { action: 'query', redirects: '1', prop: 'coordinates|pageprops', ...query },
          signal,
        ),
      ).filter(
        (page) => /^Q\d+$/.test(page.pageprops?.wikibase_item) && !seen.has(page.pageprops.wikibase_item),
      );
      if (!articles.length) continue;
      const ids = [...new Set(articles.map((page) => page.pageprops.wikibase_item))];
      ids.forEach((id) => seen.add(id));
      const entities =
        (
          await wiki(
            'https://www.wikidata.org/w/api.php',
            { action: 'wbgetentities', ids: ids.join('|'), props: 'labels|aliases|claims' },
            signal,
          )
        )?.entities ?? {};
      for (const article of articles) {
        const entity = entities[article.pageprops.wikibase_item];
        const ll = coordFrom(entity, article);
        if (!coordinates(ll) || distance(stop.ll, ll) > limit) continue;
        const labels = [
          article.title,
          ...Object.values(entity?.labels ?? {}).map((x) => x.value),
          ...Object.values(entity?.aliases ?? {})
            .flat()
            .map((x) => x.value),
        ];
        if (!labels.some((s) => keys.has(key(s)))) continue;
        const file = entity?.claims?.P18?.find((claim) => claim.rank !== 'deprecated')?.mainsnak?.datavalue
          ?.value;
        if (typeof file !== 'string' || !rasterFile(file)) continue;
        const records = pages(
          await wiki(commons, { action: 'query', titles: 'File:' + file, ...imageArgs }, signal),
        );
        const photo = commonsPhoto(records[0], 'exact');
        if (photo) return photo;
      }
    }
  }
  return null;
}
export async function nearbyPhoto(stop, signal) {
  if (!coordinates(stop.ll)) return null;
  const records = pages(
    await wiki(
      commons,
      {
        action: 'query',
        generator: 'geosearch',
        ggscoord: stop.ll.join('|'),
        ggsradius: '300',
        ggsnamespace: '6',
        ggslimit: '15',
        ...imageArgs,
      },
      signal,
    ),
  );
  const distinctive = names(stop).flatMap((name) =>
    words(name).filter((word) => word.length >= 4 && !ignored.has(word) && !/^\d+$/.test(word)),
  );
  for (const record of records) {
    const title = simplify(record.title);
    if (
      !rasterFile(title) ||
      !distinctive.some(
        (word) => words(title).includes(word) || (/[^\x00-\x7f]/.test(word) && title.includes(word)),
      )
    )
      continue;
    const photo = commonsPhoto(record, 'likely');
    if (photo) return photo;
  }
  return null;
}
export function startPlacePhotos(stop, signal, onPhotos) {
  const source = publicPage(sourceIdentity(stop.src?.url));
  const visited = new Set(source ? [source] : []);
  const fromPages = [];
  let exact = null;
  let exactFinished = false;
  let visible = [];

  function publish() {
    if (signal.aborted) return;
    const ranked = exact ? [exact, ...fromPages.filter(photo => photo.url !== exact.url)] : fromPages;
    // Keep a slot for an exact match so an already displayed photo never disappears.
    const next = ranked.slice(0, exactFinished ? 4 : 3);
    if (next.length === visible.length && next.every((photo, index) => photo === visible[index])) return;
    visible = next;
    onPhotos(next);
  }
  function addPage(photo) {
    if (photo && !fromPages.some(existing => existing.url === photo.url)) {
      fromPages.push(photo);
      publish();
    }
  }
  const wiki = exactPhoto(stop, signal).then(photo => { exact = photo; }).finally(() => {
    exactFinished = true;
    publish();
  });
  function fetchPage(url) {
    if (stop.k === 'food' && (url === source || /menu|เมนู/i.test(new URL(url).pathname))) {
      // A published menu also needs the body. Parse one shared response and expose its head early.
      return readPublicDocument(url, signal, { headOnly: false, limit: 750_000,
        onHead: (head, page) => addPage(previewFromHead(head, page, stop)),
      });
    }
    return pagePhoto(url, stop, signal).then(addPage);
  }
  const venue = source ? fetchPage(source) : null;
  const early = Promise.allSettled([wiki, venue]);
  return async function finish(pages) {
    const urls = [...new Set(pages.map(sourceIdentity).map(publicPage).filter(Boolean))].filter(url => !visited.has(url));
    for (let i = 0; i < urls.length && fromPages.length < 4; i += 2) {
      signal.throwIfAborted();
      await Promise.all(urls.slice(i, i + 2).map(fetchPage));
    }
    await early;
    signal.throwIfAborted();
    if (!visible.length) addPage(await nearbyPhoto(stop, signal));
    return visible;
  };
}
export function wikipediaPhoto(name, ll, lang, signal) {
  return exactPhoto({ n: name, ll, k: 'sight' }, signal);
}
