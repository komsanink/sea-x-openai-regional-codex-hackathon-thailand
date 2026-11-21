import { legLabels as labels, legMode, isScheduledService } from './leg-modes.js';
const colors = {
  walk: '#41793a',
  car: '#3c699a',
  own: '#295d73',
  van: '#926025',
  red: '#a7453b',
  transit: '#695396',
  rail: '#743e8c',
  metro: '#2b6c8d',
  ferry: '#14726c',
  bus: '#966025',
};
const strokes = {
  road: { width: 4, cap: 'round' },
  walk: { width: 3, cap: 'round', dash: [0.1, 2.6] },
  transit: { width: 4, cap: 'butt', dash: [3, 1.5] },
  estimate: { width: 3, cap: 'butt', dash: [3, 1.4, 0.7, 1.4], opacity: 0.76 },
  removed: { width: 3, cap: 'butt', dash: [1.2, 1.3], opacity: 0.83 },
};
function routeLabel({ mode, stroke }) {
  if (stroke === 'removed') return 'เส้นทางที่นำออก';
  return (labels[mode] || mode || 'การเดินทาง') + (stroke === 'estimate' ? ' · เส้นทางโดยประมาณ' : '');
}
const modeStroke = mode => mode === 'walk' ? 'walk' : mode === 'transit' || isScheduledService(mode) ? 'transit' : 'road';
export function routeLegendEntries(tripDays, features) {
  if (features) {
    const used = new Map();
    for (const { properties } of features) used.set(routeLabel(properties), properties);
    return [...used.values()];
  }
  const modes = new Set();
  for (const day of tripDays) {
    for (const stop of day?.stops || []) {
      const recorded = stop.leg?.mode || stop.leg?.m;
      const mode = legMode(recorded) || recorded;
      if (mode) modes.add(mode);
    }
  }
  const entries = [];
  for (const mode of new Set([...Object.keys(labels), ...modes])) {
    if (modes.has(mode)) entries.push({ mode, stroke: modeStroke(mode), color: colors[mode] || '#426353' });
  }
  return entries;
}
function renderLegend(days, features, overview) {
  const key = document.querySelector('#map-key');
  const legend = document.querySelector('#leg-label');
  const preview = document.querySelector('#map-strokes');
  document.querySelector('#overview-hint').hidden = !overview;
  preview.replaceChildren();
  const items = [];
  for (const entry of overview ? [] : routeLegendEntries(days, features)) {
    const { color, stroke } = entry;
    const style = strokes[stroke];
    const item = document.createElement('li');
    const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    swatch.setAttribute('viewBox', '0 0 38 10');
    swatch.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(swatch.namespaceURI, 'path');
    line.setAttribute('d', 'M2 5H36');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-linecap', style.cap);
    line.setAttribute('stroke-width', style.width);
    if (style.opacity) line.setAttribute('opacity', style.opacity);
    if (style.dash) line.setAttribute('stroke-dasharray', style.dash.map(n => n * style.width).join(' '));
    swatch.append(line);
    if (items.length < 3) preview.append(swatch.cloneNode(true));
    item.append(swatch, document.createTextNode(routeLabel(entry)));
    items.push(item);
  }
  legend.replaceChildren(...items);
  key.hidden = !items.length;
}
export function coordinates(value) {
  const pair = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value?.lat, value?.lng];
  if (pair.length !== 2 || pair.some((n) => n == null || String(n).trim() === '')) return;
  let [lat, lng] = pair.map(Number);
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
  if ([lat, lng].every(Number.isFinite) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng))
    return [lng, lat];
}
export function visitCoordinates(stop) {
  return stop?.place?.fallback ? undefined : coordinates(stop?.ll);
}
const distance = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
function segment(a, b, record, mode, ghost = false, estimated = false) {
  let points = record?.geom || (Array.isArray(record) ? record : null);
  if (
    points?.length >= 2 &&
    points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
  ) {
    if (distance(a, points[0]) > distance(a, [points[0][1], points[0][0]]))
      points = points.map(([x, y]) => [y, x]);
    if (distance(a, points.at(-1)) + distance(b, points[0]) < distance(a, points[0]) + distance(b, points.at(-1)))
      points = [...points].reverse();
  } else points = null;
  const approximate = !points || Boolean(record?.approx) || estimated;
  const stroke = ghost ? 'removed' : approximate ? 'estimate' : modeStroke(mode);
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points || [a, b] },
    properties: {
      mode,
      color: ghost ? '#a84646' : colors[mode] || '#426353',
      approx: approximate || ghost,
      stroke,
      revision: overlayRevision,
    },
  };
}
// A short entrance offset can meet the POI on the same line. A distant road snap stays at the road.
function nearEntrance(pin, road) {
  const metresPerDegree = 111320;
  const east = (pin[0] - road[0]) * Math.cos(pin[1] * Math.PI / 180);
  const metres = Math.hypot(east, pin[1] - road[1]) * metresPerDegree;
  return metres > 0 && metres <= 50;
}

export function dayRouteFeatures(day, routes, drafting = false) {
  const features = [], longPoints = [];
  let previous;
  for (const [i, stop] of (day?.stops || []).entries()) {
    const point = visitCoordinates(stop);
    if (!point) continue;
    const prior = previous;
    previous = { point, index: i, ordinal: stop.ordinal, stop };
    if (!prior || distance(prior.point, point) === 0) continue;
    const leg = stop.leg;
    const gap = prior.index !== i - 1 || (Number.isInteger(prior.ordinal) &&
      Number.isInteger(stop.ordinal) && stop.ordinal !== prior.ordinal + 1);
    if (gap || !leg || leg.unlocated) continue;
    const stops = { from: prior.stop.name || prior.stop.n || 'จุดที่ ' + (prior.index + 1),
      to: stop.name || stop.n || 'จุดที่ ' + (i + 1), date: day.date || '' };
    const recorded = leg.mode || leg.m;
    const mode = legMode(recorded) || recorded;
    const service = isScheduledService(mode);
    const stored = !drafting && !service && leg.real === true && Array.isArray(leg.geometry) ? leg.geometry : null;
    const record = service && !leg.key?.startsWith(mode + '|') ? null : routes?.[leg.key] || stored;
    const line = segment(prior.point, point, record, mode, false, service || leg.real === false);
    Object.assign(line.properties, stops);
    if (drafting && line.properties.approx) continue;
    features.push(line);
    const geometry = line.geometry.coordinates;
    if (leg.km >= 100) longPoints.push(...geometry);
    if (!line.properties.approx) {
      const first = nearEntrance(prior.point, geometry[0]) ? [prior.point] : [];
      const last = nearEntrance(point, geometry.at(-1)) ? [point] : [];
      if (first.length || last.length) line.geometry.coordinates = [...first, ...geometry, ...last];
    }
  }
  return { features, longPoints };
}
let map,
  loading,
  library,
  pending,
  markers = [],
  routePopup,
  overlayRevision = 0,
  previousCamera,
  cameraTarget,
  cameraFrame;

const detailZoom = 17.5;
const lineFilter = stroke => ['all', ['==', ['get', 'stroke'], stroke], ['==', ['get', 'revision'], overlayRevision]];

// Split the map around the visible docks. On small workspaces there can be more
// room below the chat than between the chat and the place sheet.
function visibleFrame(mapBox) {
  let areas = [mapBox];
  for (const selector of ['#place-panel', '#chat-response', '#map .maplibregl-ctrl-attrib']) {
    const dock = document.querySelector(selector)?.getBoundingClientRect();
    if (!dock?.width || !dock.height) continue;
    areas = areas.flatMap(area => {
      if (dock.left >= area.right || dock.right <= area.left || dock.top >= area.bottom || dock.bottom <= area.top)
        return [area];
      return [
        { ...area, right: dock.left }, { ...area, left: dock.right },
        { ...area, bottom: dock.top }, { ...area, top: dock.bottom },
      ].filter(rect => rect.right > rect.left && rect.bottom > rect.top);
    });
  }
  const room = rect => (rect.right - rect.left) * (rect.bottom - rect.top);
  return areas.reduce((largest, rect) => !largest || room(rect) > room(largest) ? rect : largest, null) || mapBox;
}

function scheduleCamera() {
  if (cameraFrame || !cameraTarget) return;
  cameraFrame = requestAnimationFrame(() => {
    cameraFrame = undefined;
    if (!cameraTarget) return;
    const box = map.getContainer().getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    map.resize();
    const rect = visibleFrame({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    const gutter = Math.min(35, (rect.right - rect.left) / 4, (rect.bottom - rect.top) / 4);
    const padding = {
      left: rect.left - box.left + gutter, right: box.right - rect.right + gutter,
      top: rect.top - box.top + gutter, bottom: box.bottom - rect.bottom + gutter,
    };
    const { bounds, focus, drafting, center } = cameraTarget;
    const signature = JSON.stringify([box.width, box.height, padding, cameraTarget]);
    if (signature === previousCamera) return;
    previousCamera = signature;
    if (focus) {
      const offset = [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2];
      map.easeTo({ center: focus, offset, zoom: Math.max(map.getZoom(), detailZoom), duration: 280 });
    } else if (bounds) {
      map.fitBounds(bounds, { padding, maxZoom: 14, duration: 0 });
    } else if (drafting) {
      map.jumpTo({ center: center || [0, 18], zoom: center ? 11 : 1.5 });
    }
  });
}

const visitDate = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
let visitPopup, pinFrame;

function showVisits(entry) {
  const entries = [...entry.group].sort((a, b) => a.order - b.order);
  if (entries.length === 1 && entry.open) {
    previousCamera = undefined;
    entry.open(entry.stop);
    return;
  }
  visitPopup?.remove();
  routePopup?.remove();
  const content = document.createElement('div');
  content.className = 'map-visits';
  const heading = document.createElement('strong');
  heading.textContent = 'เลือกจุดแวะบนแผนที่';
  content.append(heading);
  const point = map.project(entry.marker.getLngLat());
  const {clientWidth, clientHeight} = map.getContainer();
  const width = Math.min(250, clientWidth - 14);
  const above = point.y - 52, below = clientHeight - point.y - 46;
  const vertical = above >= below ? 'bottom' : 'top';
  const side = point.x < width / 2 ? '-left' : point.x > clientWidth - width / 2 ? '-right' : '';
  content.style.maxHeight = Math.max(40, Math.min(230, Math.max(above, below) - 44)) + 'px';
  const popup = new library.Popup({
    anchor: vertical + side, offset: 13, maxWidth: width + 'px',
    className: 'visits-popup', focusAfterOpen: false, closeOnMove: true,
  });
  for (const member of entries) {
    const row = document.createElement(member.open ? 'button' : 'p');
    const when = document.createElement('small');
    when.textContent = member.when;
    row.append(when, document.createTextNode(member.title));
    if (member.open) {
      row.type = 'button';
      row.dataset.visit = member.stop.id;
      row.onclick = () => {
        popup.remove();
        previousCamera = undefined;
        member.open(member.stop);
      };
    }
    content.append(row);
  }
  visitPopup = popup.setLngLat(entry.marker.getLngLat()).setDOMContent(content).addTo(map);
  popup.getElement().setAttribute('role', 'dialog');
  popup.getElement().setAttribute('aria-label', heading.textContent);
  const close = popup.getElement().querySelector('.maplibregl-popup-close-button');
  close.setAttribute('aria-label', 'ปิดรายการจุดแวะ');
  close.onclick = () => entry.el.focus({ preventScroll: true });
  popup.getElement().onkeydown = event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      popup.remove();
      entry.el.focus({ preventScroll: true });
    }
  };
  (content.querySelector('button') || close).focus({ preventScroll: true });
}

export function groupNearbyVisits(projected) {
  const groups = [];
  for (const {entry, x, y} of projected) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const cluster = groups.find(g => Math.hypot(g.x - x, g.y - y) < 44);
    if (cluster) cluster.members.push(entry);
    else groups.push({x, y, members: [entry]});
  }
  return groups;
}

function arrangePins() {
  if (!map || !markers.length) return;
  const {clientWidth: width, clientHeight: height} = map.getContainer();
  const focused = markers.find(entry => entry.el.dataset.focused === 'true');
  const priority = focused ? [focused, ...markers.filter(entry => entry !== focused)] : markers;
  const groups = groupNearbyVisits(priority.map(entry => {
    const {x, y} = map.project(entry.marker.getLngLat());
    return {entry, x, y};
  }));
  const active = markers.find(entry => entry.el === document.activeElement);
  const leaders = new Set(groups.map(group => group.members[0]));
  for (const entry of markers) entry.el.hidden = !leaders.has(entry);
  if (active?.el.hidden) groups.find(g => g.members.includes(active))?.members[0].el.focus({preventScroll: true});
  const obstacles = groups.map(({x, y}) => ({left: x - 18, right: x + 18, top: y - 18, bottom: y + 18}));
  for (const {members, x, y} of groups) {
    const entry = members[0];
    entry.group = members;
    const {el, group, badge, tag} = entry;
    const multiple = group.length > 1;
    el.classList.toggle('group-pin', multiple);
    el.disabled = !multiple && !entry.open;
    if (multiple) el.setAttribute('aria-haspopup', 'dialog');
    else el.removeAttribute('aria-haspopup');
    entry.face.textContent = entry.overview ? (multiple ? String(group.length) : '') : entry.number;
    badge.hidden = !multiple || entry.overview;
    if (!badge.hidden) badge.textContent = '+' + (group.length - 1);
    const name = multiple ? group.length + ' จุดแวะในบริเวณนี้ · เลือกจุดแวะ' : entry.when + ' · ' + entry.title;
    el.title = name;
    el.setAttribute('aria-label', name);
    tag.hidden = entry.overview && !entry.stop.star && entry !== focused;
    if (tag.hidden) continue;
    const w = tag.offsetWidth, h = tag.offsetHeight;
    const gap = multiple && !entry.overview ? 25 : 18;
    let placed = false;
    for (const side of ['right', 'left']) {
      const left = side === 'right' ? x + gap : x - gap - w;
      const rect = {left, right: left + w, top: y - h / 2, bottom: y + h / 2};
      if (rect.left < 0 || rect.right > width || rect.top < 0 || rect.bottom > height) continue;
      if (obstacles.some(o => o.left < rect.right && rect.left < o.right && o.top < rect.bottom && rect.top < o.bottom)) continue;
      tag.dataset.side = side;
      obstacles.push(rect);
      placed = true;
      break;
    }
    tag.hidden = !placed;
  }
}
function queuePins() {
  if (!pinFrame) pinFrame = requestAnimationFrame(() => { pinFrame = undefined; arrangePins(); });
}

function paint() {
  if (!map?.isStyleLoaded() && !map?.getSource('trip')) return;
  const { days, routes, before, open, focusedStop, drafting, center, overview } = pending;
  let focusPoint;
  const points = [], features = [];
  const activePin = document.activeElement?.closest('.map-pin')?.dataset.mapStop;
  for (const { marker } of markers) marker.remove();
  markers = [];
  visitPopup?.remove();
  function pin(stop, p, index, ghost, day) {
    points.push(p);
    if (stop.id === focusedStop) focusPoint = p;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'map-pin' + (ghost ? ' removed' : '');
    el.dataset.mapStop = stop.id;
    el.dataset.focused = String(stop.id === focusedStop);
    const ordinal = drafting && Number.isInteger(stop.ordinal) ? stop.ordinal : index + 1;
    const date = Date.parse(day.date);
    const when = [Number.isFinite(date) && visitDate.format(date), (drafting && open ? 'ตัวเลือก ' : 'จุดที่ ') + ordinal, stop.start].filter(Boolean).join(' · ');
    const title = (ghost ? 'นำออก · ' : '') + (stop.name || stop.n || 'จุดแวะ') +
      (stop.place?.source === 'model' ? ' · ตำแหน่งโดยประมาณ' : '');
    const overviewPin = overview || (drafting && days.length > 1);
    el.classList.toggle('overview-pin', overviewPin);
    const [face, badge, tag] = ['map-pin-face', 'map-pin-count', 'map-pin-name'].map(cls => {
      const span = document.createElement('span');
      span.className = cls;
      span.setAttribute('aria-hidden', 'true');
      el.append(span);
      return span;
    });
    tag.textContent = stop.name || stop.n;
    const marker = new library.Marker({ element: el }).setLngLat(p).addTo(map);
    const entry = {marker, el, stop, title, when, number: ghost ? '−' : String(ordinal), overview: overviewPin, open, face, badge, tag, order: markers.length};
    el.onclick = event => { event.stopPropagation(); showVisits(entry); };
    markers.push(entry);
    if (stop.id === activePin) el.focus({ preventScroll: true });
  }
  for (const day of days.filter(Boolean)) {
    const stops = day.stops || [];
    stops.forEach((stop, i) => {
      const p = visitCoordinates(stop);
      if (p) pin(stop, p, i, false, day);
    });
    if (overview) continue;
    const lines = dayRouteFeatures(day, routes, drafting);
    features.push(...lines.features);
    points.push(...lines.longPoints);
    if (before) {
      const kept = new Set(stops.map((s) => s.id));
      before.stops.forEach((stop, i, old) => {
        const p = visitCoordinates(stop);
        if (!p || kept.has(stop.id)) return;
        pin(stop, p, i, true, before);
        for (const adjacent of [old[i - 1], old[i + 1]]) {
          const other = visitCoordinates(adjacent);
          if (other) features.push(segment(p, other, null, 'walk', true));
        }
      });
    }
  }
  const data = { type: 'FeatureCollection', features };
  if (map.getSource('trip')) map.getSource('trip').setData(data);
  else {
    map.addSource('trip', { type: 'geojson', data });
    for (const [stroke, style] of Object.entries(strokes)) {
      const id = 'trip-' + stroke;
      map.addLayer({
        id,
        type: 'line',
        source: 'trip',
        filter: lineFilter(stroke),
        layout: { 'line-cap': style.cap, 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': style.width,
          'line-opacity': style.opacity || 1,
          ...(style.dash && { 'line-dasharray': style.dash }),
        },
      });
      map.on('click', id, (event) => {
        routePopup?.remove();
        const leg = event.features[0].properties;
        const date = Date.parse(leg.date);
        const path = [leg.from, leg.to].filter(Boolean).join(' → ');
        const description = [Number.isFinite(date) && visitDate.format(date), path, routeLabel(leg)].filter(Boolean);
        routePopup = new library.Popup()
          .setLngLat(event.lngLat)
          .setText(description.join(' · '))
          .addTo(map);
      });
    }
  }
  renderLegend(days, features, overview);
  arrangePins();
  const bounds = points.length && points.reduce((box, p) => box.extend(p), new library.LngLatBounds()).toArray();
  const visibleDays = days.map(day => day && [day.date, day.stops?.map(stop => stop.id)]);
  cameraTarget = { bounds, focus: focusPoint, focusedStop, drafting, center, visibleDays };
  scheduleCamera();
}
export function drawMap(days, routes, open, before, focusedStop, draft, overview = false) {
  const drafting = Boolean(draft), center = coordinates(draft?.cityLL);
  if (draft?.restart || pending?.drafting !== drafting || pending?.overview !== overview || (!drafting && pending?.days[0] !== days[0])) {
    // MapLibre's worker can still be painting the preceding GeoJSON tiles.
    // Hide that revision immediately while the new source data is being indexed.
    overlayRevision++;
    for (const stroke of Object.keys(strokes)) {
      const id = 'trip-' + stroke;
      if (map?.getLayer(id)) map.setFilter(id, lineFilter(stroke));
    }
    for (const { marker } of markers) marker.remove();
    markers = [];
    routePopup?.remove();
    visitPopup?.remove();
    map?.stop();
    previousCamera = undefined;
    cameraTarget = drafting ? { drafting, center } : null;
    if (map) scheduleCamera();
  }
  pending = { days, routes, open, before, focusedStop, drafting, center, overview };
  if (map && (map.isStyleLoaded() || map.getSource('trip'))) {
    paint();
    return;
  }
  // A saved trip already has travel modes while the map worker is still loading.
  renderLegend(days, undefined, overview);
  if (map || loading || (!draft && !days.some((day) => day?.stops?.length))) return;
  loading = import('/assets/maplibre-gl.mjs?v=6.19.0')
    .then((lib) => {
      library = lib;
      lib.setWorkerUrl('/assets/maplibre-gl-worker.mjs?v=6.19.0');
      const container = document.querySelector('#map');
      container.replaceChildren();
      const dark = matchMedia('(prefers-color-scheme: dark)');
      const style = () => 'https://tiles.openfreemap.org/styles/' + (dark.matches ? 'dark' : 'positron');
      const center = pending.center || pending.days.flatMap(day => day?.stops || []).map(visitCoordinates).find(Boolean);
      map = new lib.Map({ container, style: style(), center: center || [0, 18], zoom: center ? 11 : 1.5, scrollZoom: false });
      const sizeChanges = new ResizeObserver(scheduleCamera);
      for (const target of [container, document.querySelector('#place-panel'), document.querySelector('#chat-response')])
        if (target) sizeChanges.observe(target);
      for (const event of ['move', 'resize', 'moveend']) map.on(event, queuePins);
      let baseReady = false;
      map.on('error', () => {
        if (!baseReady && !map.isStyleLoaded()) {
          baseReady = true;
          map.setStyle({
            version: 8,
            sources: {},
            layers: [{ id: 'backdrop', type: 'background', paint: { 'background-color': '#e4eade' } }],
          });
        }
      });
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      const mapCard = container.closest('.map-card');
      const attribution = container.querySelector('.maplibregl-ctrl-attrib');
      const controlSizes = new ResizeObserver(() => {
        mapCard.style.setProperty('--map-credit-space', (attribution?.offsetHeight || 0) + 18 + 'px');
        scheduleCamera();
      });
      if (attribution) controlSizes.observe(attribution);
      map.on('style.load', () => {
        baseReady = true;
        for (const layer of map.getStyle().layers || []) {
          if (
            layer.type === 'symbol' &&
            layer.layout?.['text-field'] &&
            /name/.test(JSON.stringify(layer.layout['text-field']))
          ) {
            map.setLayoutProperty(layer.id, 'text-field', [
              'coalesce',
              ['get', 'name:th'],
              ['get', 'name'],
              layer.layout['text-field'],
            ]);
          }
        }
        map.once('idle', paint);
        paint();
      });
      dark.addEventListener('change', () => map.setStyle(style()));
    })
    .catch(() => {
      loading = null;
      document.querySelector('#map').textContent = 'เปิดแผนที่ไม่สำเร็จ ดูจุดแวะและเส้นทางในกำหนดการได้';
    });
}
