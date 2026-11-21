import { isLodgingStop, needsLodgingChoice } from './lodging-state.js';
import { createLodgingChooser } from './lodging-chooser.js';
import { presentChecks } from './check-presentation.js';
import { appendTrace, finishTrace } from './operation-trace.js';
import { renderBookingTasks, reconcileReservations, reservationStatus, setReservationDone } from './booking-tasks.js';
import { describePlanChange, renderPlanReview, renderRepairOutcome } from './plan-review.js';
import { openPlaceSheet, closePlaceSheet, createStopMenu, refreshPlaceLocation } from './place-details.js';
import { renderStopNote, splitStopNote } from './stop-note.js';
import { attachLocationSuggestions, localSuggestions } from './location-suggest.js';
import { bindWorkspace, renderPeople } from './workspace-controls.js';
import { installSetupExtras, chooseCandidates } from './setup-extras.js';
import { createForecast } from './forecast.js';
import { visitDate, visitAvailability, stopFacts, legFacts } from './itinerary-facts.js';
import { coordinates, drawMap, visitCoordinates } from './map.js';
import { legLabels, legMode, isScheduledService } from './leg-modes.js';
import { applySavedMap } from './saved-map.js';
import { fetchStream, readEvents } from './stream.js';
import {
  bindTripIntegrations,
  newTripIntegrationKey,
  renderTripIntegrations,
  renderLineVote,
  renderAppliedLine,
  lineMessageBubble,
  canNotifyWeather,
  notifyWeather,
} from './trip-integrations.js';
const $ = (selector) => document.querySelector(selector);
const setupForm = $('#setup-form');
const setupDialog = $('#setup-dialog');
const status = $('#status');
const cash = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
const calendar = new Intl.DateTimeFormat('th-TH', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const presets = {
  เชียงใหม่: ['TH', 'THB', 18.7883, 98.9853],
  กรุงเทพฯ: ['TH', 'THB', 13.7563, 100.5018],
  ดานัง: ['VN', 'VND', 16.0544, 108.2022],
  โตเกียว: ['JP', 'JPY', 35.6762, 139.6503],
  ไทเป: ['TW', 'TWD', 25.033, 121.5654],
  โซล: ['KR', 'KRW', 37.5665, 126.978],
};
const modes = { undecided: 'ให้ Bop เลือกให้', flight: 'เครื่องบิน', drive: 'ขับรถ', bus: 'รถบัส', train: 'รถไฟ' };
const kind = {
  food: 'อาหาร',
  hotel: 'ที่พัก',
  nature: 'ธรรมชาติ',
  view: 'จุดชมวิว',
  sight: 'สถานที่เที่ยว',
  terminal: 'จุดเดินทางกลับ',
  transit: 'จุดเดินทาง',
  stay: 'ที่พัก',
  market: 'ตลาด',
};
const dayMs = 86_400_000;
const ymd = (time) => new Date(time).toISOString().slice(0, 10);
const tripLength = () =>
  Math.min(
    7,
    Math.max(
      1,
      Math.round((Date.parse(setupForm.endDate.value) - Date.parse(setupForm.startDate.value)) / dayMs) + 1 ||
        1,
    ),
  );
const dateLabel = (value) => calendar.format(new Date(value + 'T00:00:00Z'));
const lookupCache = new Map();
const selectedLocations = new WeakMap();
function savedLocation(input) {
  const hit = selectedLocations.get(input);
  return hit?.name === input.value.trim() ? hit : undefined;
}
function withSuggestions(input, kind, onSelect) {
  attachLocationSuggestions(input, {
    kind,
    getContext: () => {
      if (kind === 'city') return {};
      const city = setupForm.city.value.trim();
      const center = lookupCache.get(city)?.ll ?? presets[city]?.slice(2);
      return { city, center };
    },
    onSelect: (item) => {
      selectedLocations.set(input, item);
      if (kind === 'city') lookupCache.set(item.name, item);
      onSelect?.(item);
    },
  });
}
withSuggestions(setupForm.city, 'city');
const history = [];
let state = { plan: null, routes: {}, setup: {}, selected: 0, demo: true, bookings: {}, cancellations: [] };
let busy = false;
let focusedStop;
let archivedMap;
let menuScope;
let original, preview, activePlanning, activeReplan;
let allDays = false,
  view = 'plan',
  readiness;
function presentSummary(text) {
  const summary = $('#plan-summary');
  const prose = splitStopNote(text).text;
  summary.hidden = !prose;
  summary.querySelector('p').textContent = prose;
  status.textContent = '';
}
function updateTripLink() {
  if (state.localTripId) window.history.replaceState(null, '', '#trip=' + state.localTripId);
}
function newTrip() {
  lodgingChooser.reset();
  archivedMap?.controller?.abort();
  archivedMap = null;
  bindTripIntegrations(state);
  closePlaceSheet($('#place-panel'), { restoreFocus: false });
  focusedStop = null;
  presentSummary('');
  forecast.reset();
  original = structuredClone(state);
  preview = null;
  pendingVotes = null;
  history.length = 0;
  view = 'plan';
  allDays = false;
  setItineraryExpanded(true);
  clearChat();
  $('#command').value = '';
  $('#alerts').replaceChildren();
}
async function checkHealth(signal) {
  try {
    const timeout = AbortSignal.timeout(10000);
    const reply = await fetch('/api/health', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!reply.ok) throw Error();
    readiness = await reply.json();
    $('#readiness').textContent = readiness.ai
      ? 'Bop พร้อมวางแผน'
      : 'ยังไม่ได้ตั้งค่าบริการ AI บนเซิร์ฟเวอร์';
  } catch {
    signal?.throwIfAborted();
    readiness = null;
    $('#readiness').textContent = 'ติดต่อ Bop ไม่ได้';
  }
  return readiness;
}
const hasLiveService = () => readiness?.ai === true && readiness.provider !== 'fake';
let pendingVotes = null;
const forecast = createForecast({
  getState: () => state,
  isBusy: () => busy || !!pendingVotes || !!preview,
  onChange: () => render(),
  onReplan: (command, day) => task(() => adjust(command, day)),
  canNotify: canNotifyWeather,
  notify: notifyWeather,
});
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function button(text, action, className = 'quiet') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function field(label, name, { type = 'text', value = '', min, max, maxLength, placeholder } = {}) {
  const wrap = node('label', label);
  const input = node('input');
  input.name = name;
  input.type = type;
  input.value = value;
  if (min != null) input.min = min;
  if (max != null) input.max = max;
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  wrap.append(input);
  return wrap;
}
function selectField(label, name, options, value) {
  const wrap = node('label', label);
  const select = node('select');
  select.name = name;
  for (const [key, title] of Object.entries(options)) {
    const option = node('option', title);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  wrap.append(select);
  return wrap;
}
function clean(value, key = '') {
  if (typeof value === 'string')
    return ['url', 'page', 'href', 'model', 'id'].includes(key)
      ? value
      : value.replace(/Claude|Anthropic/gi, 'Bop');
  if (Array.isArray(value)) return value.map((item) => clean(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, key === 'setup' && k === 'title' ? v : clean(v, k)]));
  return value;
}
async function api(path, payload, onDay, { signal = activePlanning?.signal, onStep, onMap } = {}) {
  const response = await fetchStream(path, {
    signal,
    ...(payload === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  const result = await readEvents(response, (event) => {
    signal?.throwIfAborted();
    if (event.type === 'step') {
      const text = clean(event.text || '');
      if (onStep) onStep(text);
      else status.textContent = text;
    }
    if (event.type === 'day') onDay?.(clean(event));
    if (event.type === 'map') onMap?.(clean(event));
  });
  return clean(result);
}
function setBusy(value) {
  busy = value;
  for (const selector of ['#open-setup', '#hero-setup', '#replan button'])
    $(selector).disabled = value;
  $('#undo').disabled = value || !history.length;
  $('#reset-plan').disabled = value || !original;
}
async function task(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    status.textContent = error.message || 'Bop ทำรายการไม่สำเร็จ';
  } finally {
    setBusy(false);
  }
}
function itineraryDate(day, index, setup) {
  const recorded = Date.parse(day?.date);
  if (Number.isFinite(recorded)) return calendar.format(recorded);
  const start = Date.parse(setup?.startDate);
  return Number.isFinite(start) ? calendar.format(start + index * dayMs) : 'วันที่ ' + (index + 1);
}
function dayTotals(day) {
  const stops = day?.stops || [];
  const cost = stops.reduce((sum, stop) => sum + Number(stop.cost || 0) + Number(stop.leg?.cost || 0), 0);
  const walk = stops.reduce((sum, stop) => sum + Number(stop.walk || stop.walkKm || 0) +
    ((stop.leg?.mode ?? stop.leg?.m) === 'walk' ? Number(stop.leg.km || 0) : 0), 0);
  return 'เดิน ' + walk.toFixed(1) + ' กม. · ฿' + cash.format(cost);
}
function checkLabel(check) {
  const label = node('span', check.label, 'check-label');
  if (check.member) label.append(node('small', ' · ' + check.member, 'check-meta'));
  return label;
}
function failedCheck(check) {
  const { issues } = check;
  const row = node(issues.length ? 'details' : 'div', null, 'check-failure');
  const heading = node(issues.length ? 'summary' : 'div', null, 'check-summary');
  const mark = node('span', '!', 'check-mark');
  mark.setAttribute('aria-hidden', 'true');
  const text = node('span', null, 'check-text');
  const label = checkLabel(check);
  if (issues.length > 1) label.append(node('small', ' · ' + issues.length + ' รายการ', 'check-meta'));
  text.append(label);
  if (issues.length) {
    const first = issues[0];
    const reason = first.detail.split(' · ')[0];
    const preview = [reason, first.subject || first.when].filter(Boolean).join(' · ');
    if (preview) text.append(node('small', preview, 'check-preview'));
  }
  heading.append(mark, text);
  row.append(heading);
  if (issues.length) {
    const list = node('ul', null, 'check-issues');
    for (const issue of issues) {
      const entry = node('li');
      if (issue.when) entry.append(node('small', issue.when));
      if (issue.subject) entry.append(node('strong', issue.subject));
      if (issue.detail) entry.append(node('p', issue.detail));
      list.append(entry);
    }
    row.append(list);
  }
  return row;
}
let displayedCheckPlan;
function renderChecks(plan) {
  if (displayedCheckPlan === plan) return;
  displayedCheckPlan = plan;
  const container = $('#checks-list'), count = $('#checks-count');
  container.replaceChildren();
  count.textContent = '';
  if (!plan) return;
  const checks = presentChecks(plan, plan.setup ?? state.setup);
  if (!checks.length) return;
  const passed = checks.filter(check => check.pass), failed = checks.filter(check => !check.pass);
  count.textContent = 'ผ่าน ' + passed.length + '/' + checks.length + ' ข้อ';
  count.dataset.state = failed.length ? 'partial' : 'complete';
  if (failed.length) {
    container.append(node('h3', 'ต้องปรับ ' + failed.length + ' ข้อ', 'check-attention'));
    const group = node('div', null, 'check-failures');
    for (const check of failed) group.append(failedCheck(check));
    container.append(group);
  }
  if (passed.length) {
    const group = node('details', null, 'check-passed');
    const title = node('summary', failed.length ? 'ดูเงื่อนไขที่ผ่านแล้ว' : 'ดูเงื่อนไขทั้งหมด');
    const list = node('ul');
    for (const check of passed) {
      const item = node('li');
      const mark = node('span', '✓', 'check-tick');
      mark.setAttribute('aria-hidden', 'true');
      item.append(mark, checkLabel(check));
      list.append(item);
    }
    group.append(title, list);
    container.append(group);
  }
}
async function recoverDayMap(plan, index) {
  const archive = archivedMap;
  if (archive?.plan !== plan || archive.checked.has(index)) return;
  const day = plan.days[index];
  if (!day?.stops.some(stop => !visitCoordinates(stop) && typeof stop.query === 'string' && stop.query.trim())) return;
  if (archive.pending === index) return;
  archive.controller?.abort();
  const controller = new AbortController();
  archive.controller = controller;
  archive.pending = index;
  try {
    const response = await fetch('/api/local-trips/' + archive.id + '/map/' + index, { signal: controller.signal });
    if (!response.ok) return;
    const patch = await response.json();
    if (controller.signal.aborted || archivedMap !== archive || state.plan !== plan || preview || activePlanning || activeReplan) return;
    archive.checked.add(index);
    if (!patch.locations?.length) return;
    applySavedMap(plan, state.routes, patch);
    if (original?.localTripId === archive.id) applySavedMap(original.plan, original.routes, patch);
    if (state.selected !== index) return;
    const current = day.stops.find(stop => stop.id === focusedStop);
    if (current && [...patch.locations, ...patch.legs].some(update => update.id === current.id))
      refreshPlaceLocation($('#place-panel'), current, plan.city, day);
    render();
  } catch {
    // The saved itinerary remains usable when a location service is unavailable.
  } finally {
    if (archive.controller === controller) archive.pending = undefined;
  }
}
const lodgingChooser = createLodgingChooser($('#lodging-chooser'), {
  request(plan, action, shortlist, signal, onStep) {
    if (state.plan !== plan) throw Error('แผนทริปเปลี่ยนแล้ว');
    if (state.localTripId)
      return api('/api/local-trips/' + state.localTripId + '/lodging', action, undefined, { signal, onStep });
    // A stateless server verifies the offered ids against the look-up result on confirmation.
    const offeredPlan = action.action === 'options' ? plan : {
      ...plan,
      flags: { ...plan.flags, stay: {
        ...plan.flags?.stay, options: shortlist.options, recommendedId: shortlist.recommendedId,
        offerRef: shortlist.offerRef || plan.flags?.stay?.offerRef,
      } },
    };
    return api('/api/plan/lodging', { ...action, plan: offeredPlan, routes: state.routes }, undefined, { signal, onStep });
  },
  apply(plan, result) {
    if (state.plan !== plan || activePlanning || activeReplan || preview || pendingVotes) return;
    archivedMap?.controller?.abort();
    const reservations = reconcileReservations(state, result.plan);
    Object.assign(state, reservations);
    state.plan = result.plan;
    state.setup = result.plan.setup;
    state.routes = result.routes || {};
    if (result.localTripId) state.localTripId = result.localTripId;
    archivedMap = state.localTripId ? { id: state.localTripId, plan: state.plan, checked: new Set() } : null;
    if (original && !history.length) {
      original.plan = structuredClone(state.plan);
      original.setup = original.plan.setup;
      original.routes = structuredClone(state.routes);
      original.localTripId = state.localTripId;
      Object.assign(original, structuredClone(reservations));
    }
    presentSummary(result.summary);
    updateTripLink();
    render();
    forecast.refresh();
  },
});
function chooseLodging() {
  if (state.sample || state.demo || activeReplan || activePlanning || preview || pendingVotes || !needsLodgingChoice(state.plan)) return;
  lodgingChooser.open(state.plan);
}
function render() {
  const plan = preview?.plan || state.plan;
  if (plan?.days.length) state.selected = Math.max(0, Math.min(state.selected, plan.days.length - 1));
  const day = plan?.days[state.selected];
  const menuDay = view === 'plan' && !preview ? day : null;
  const liveResearch = hasLiveService();
  if (menuScope?.day !== menuDay || menuScope?.liveResearch !== liveResearch) {
    menuScope?.controller.abort();
    menuScope = { day: menuDay, liveResearch, controller: new AbortController(), menus: new Map() };
  }
  $('#views').hidden = !plan;
  $('#plan-panel').hidden = view !== 'plan';
  $('#book-panel').hidden = view !== 'book';
  document.querySelector('.command-panel').hidden = !plan;
  $('#plan-tab').setAttribute('aria-selected', String(view === 'plan'));
  $('#book-tab').setAttribute('aria-selected', String(view === 'book'));
  $('#day-map').setAttribute('aria-pressed', String(!allDays));
  $('#whole-map').setAttribute('aria-pressed', String(allDays));
  if ($('#planning-progress').hidden) {
    const mapTitle = $('#map-title');
    mapTitle.textContent = preview ? 'ตัวอย่างแผน ' + preview.key : 'แผนที่ทริป';
    mapTitle.classList.toggle('map-accessible-text', !preview);
  }
  const dateStrip = $('#tabs');
  const retainDateFocus = dateStrip.contains(document.activeElement);
  const dateScroll = dateStrip.scrollLeft;
  const previousDate = dateStrip.dataset.activeDate;
  dateStrip.replaceChildren();
  $('#itinerary').replaceChildren();
  renderChecks(plan);
  $('#plan-repair').replaceChildren();
  if (!preview) renderRepairOutcome($('#plan-repair'), plan?.repairOutcome);
  $('#totals').textContent = '';
  if (!plan) {
    $('#itinerary').append(node('p', 'ยังไม่มีแผนทริป', 'empty'));
    return;
  }
  renderPeople(state.setup, plan);
  const usageNote = $('#usage-note');
  if (usageNote) {
    usageNote.textContent = state.usage?.provider === 'fake' ? 'ข้อมูลทดสอบ' : '';
    usageNote.hidden = !usageNote.textContent;
  }
  const tripTitle = state.setup.title || plan.city;
  $('#city-title').textContent = tripTitle;
  $('#trip-summary').textContent = [
    tripTitle !== plan.city ? plan.city : '',
    plan.days.length + ' วัน',
    'เพื่อน ' + (state.setup.members?.length ?? 0) + ' คน',
  ].filter(Boolean).join(' · ');
  if (pendingVotes) {
    const notice = node('div', null, 'preview-note');
    const date = itineraryDate(day, state.selected, plan.setup || state.setup);
    const title = node('strong', (preview ? 'ตัวอย่างแผน ' + preview.key : 'แผนปัจจุบัน') + ' · ' + date);
    title.tabIndex = -1;
    notice.append(title, button('กลับไปดูตัวเลือก', () => {
      setChatExpanded(true);
      const control = $('#options [data-preview][aria-pressed="true"]') || $('#options [data-preview]');
      control?.focus({ preventScroll: true });
      control?.scrollIntoView({ block: 'nearest' });
    }));
    $('#itinerary').append(notice);
  }
  const stops = plan.days.flatMap((row) => row?.stops ?? []);
  const lodgingPending = !preview && !state.sample && !state.demo && needsLodgingChoice(plan);
  const total = stops.reduce((sum, stop) => sum + Number(stop.cost || 0) + Number(stop.leg?.cost || 0), 0);
  const unknownRoomPrice = plan.flags?.stay?.stays?.some(stay => stay.recommended && !Number.isFinite(stay.cost));
  $('#totals').textContent = '฿' + cash.format(total) + ' / คน' + (unknownRoomPrice ? ' · ยังไม่รวมค่าที่พัก' : '');
  const changes = new Map((preview ? describePlanChange(state.plan, plan).changes : []).map(change => [change.id, change]));
  const changedDays = new Set([...changes.values()].flatMap((change) => [change.before?.day, change.after?.day]));
  const dates = plan.days.map((item, i) => visitDate(item, i, plan.setup || state.setup));
  const availability = new Map();
  for (let i = 0; i < plan.days.length; i++) {
    const tabDay = plan.days[i];
    const tab = button(itineraryDate(tabDay, i, plan.setup || state.setup), () => {
      focusedStop = null;
      state.selected = i;
      closePlaceSheet($('#place-panel'), { restoreFocus: false });
      allDays = false;
      render();
    });
    tab.setAttribute('aria-current', i === state.selected ? 'true' : 'false');
    if (tabDay) {
      tab.append(node('small', dayTotals(tabDay)));
      let closed = false, outside = false;
      for (const stop of tabDay.stops) {
        const fact = visitAvailability(stop, dates[i]);
        availability.set(stop, fact);
        closed ||= Boolean(fact.reason);
        outside ||= !fact.reason && fact.outsideHours;
      }
      const warnings = [
        changedDays.has(i + 1) && 'มีการปรับแผน',
        closed && 'มีสถานที่ปิด',
        outside && 'นอกเวลาเปิด',
        forecast.dayLabel(plan, i),
      ].filter(Boolean);
      if (warnings.length) tab.append(node('small', warnings.join(' · '), 'day-notices'));
    }
    dateStrip.append(tab);
  }
  dateStrip.scrollLeft = dateScroll;
  const dateKey = day?.date || String(state.selected);
  if (previousDate !== dateKey || dateStrip.dataset.wasVisible !== 'true') {
    const current = dateStrip.children[state.selected];
    if (current && dateStrip.clientWidth) {
      const bounds = dateStrip.getBoundingClientRect();
      const button = current.getBoundingClientRect();
      if (button.left < bounds.left) dateStrip.scrollLeft += button.left - bounds.left;
      else if (button.right > bounds.right) dateStrip.scrollLeft += button.right - bounds.right;
    }
  }
  if (retainDateFocus) dateStrip.children[state.selected]?.focus({ preventScroll: true });
  dateStrip.dataset.activeDate = dateKey;
  dateStrip.dataset.wasVisible = String(Boolean(dateStrip.clientWidth));
  if (!day?.stops.length)
    $('#itinerary').append(node('p', day ? 'ยังไม่มีจุดแวะในวันนี้' : 'Bop กำลังจัดแผนวันนี้', 'empty'));
  else {
    const title = node('h3', day.title, 'day-title');
    $('#itinerary').append(title);
    for (const [order, stop] of day.stops.entries()) {
      if (order && stop.leg) {
        const leg = stop.leg;
        const mode = legMode(leg.mode ?? leg.m);
        const estimatedService = isScheduledService(mode);
        const unlocated = leg.unlocated || stop.place?.fallback || day.stops[order - 1].place?.fallback;
        const parts = unlocated ? [
          legLabels[mode],
          'ยังไม่ทราบเส้นทางระหว่างจุดแวะ',
          Number.isFinite(leg.min) && leg.min > 0 && 'เวลาเดินทางประมาณ ' + leg.min + ' นาที',
        ] : [
          legLabels[mode] || 'เดินทาง',
          Number.isFinite(leg.min) && leg.min + ' นาที',
          Number.isFinite(leg.km) && leg.km.toFixed(1) + ' กม.',
          Number.isFinite(leg.cost) && (estimatedService && leg.autoPrice ? 'ค่าโดยสารประมาณ ฿' : '฿') + cash.format(leg.cost) + ' / คน',
          leg.minSrc === 'web' && 'เวลาตามแหล่งข้อมูล',
          estimatedService || !leg.real ? 'เส้นทางโดยประมาณ' : 'ตามถนนจริง',
        ];
        const line = node('p', parts.filter(Boolean).join(' · '), 'leg');
        if (!unlocated)
          for (const detail of legFacts(leg)) line.append(node('small', detail, 'leg-detail'));
        $('#itinerary').append(line);
      }
      const row = node('article', null, 'stop');
      row.dataset.stopId = stop.id;
      row.dataset.focused = String(stop.id === focusedStop);
      const name = stop.name || stop.n;
      const start = stop.start || stop.t0, end = stop.end || stop.t1;
      const time = node('time', start);
      if (end && end !== start) time.append(node('small', end));
      const content = node('div');
      const meta = node('div', null, 'stop-meta');
      const chip = (text, status) => {
        const item = node('span', text, 'stop-chip');
        if (status) item.dataset.status = status;
        meta.append(item);
      };
      const kindId = stop.kind || stop.k;
      const label = kind[kindId] || kindId || 'กิจกรรม';
      chip(label);
      if (!visitCoordinates(stop)) chip('ยังไม่ทราบพิกัด', 'warn');
      if (unknownRoomPrice && ['stay', 'hotel'].includes(stop.k ?? stop.kind) && !stop.cost) chip('ยังไม่ทราบค่าห้องพัก');
      else if (Number.isFinite(stop.cost)) chip('฿' + cash.format(stop.cost) + ' / คน');
      const visit = availability.get(stop);
      if (visit.reason) chip('ปิดในวันที่วางแผน · ' + visit.reason, 'closed');
      else if (visit.weekRule) chip(visit.weekRule);
      const opening = visit.hours || (typeof stop.open === 'string' ? stop.open.trim() : '');
      if (opening && !visit.reason)
        chip('เปิด ' + opening + (visit.outsideHours ? ' · แผนอยู่นอกเวลาเปิด' : ''), visit.outsideHours ? 'warn' : '');
      for (const item of Array.isArray(stop.closures) ? stop.closures : []) {
        const date = item?.date ?? item;
        if (date !== dates[state.selected] && dates.includes(date))
          chip('ปิด ' + dateLabel(date) + (item?.why ? ' · ' + item.why : ''));
      }
      const interested = state.setup.members?.find(person => stop.star && person.id === stop.star);
      if (interested) chip(interested.name + ' อยากไป', 'wish');
      for (const [label, status] of stopFacts(stop, (plan.setup || state.setup).members, state.bookings[stop.id])) chip(label, status);
      const change = changes.get(stop.id);
      if (change?.kinds.includes('retimed')) time.append(node('del', change.before.start));
      if (change) {
        const added = change.kinds.includes('added');
        const note = node('small', added ? 'เพิ่มในแผน' : 'ปรับจากแผนเดิม', 'stop-change');
        note.dataset.status = added ? 'added' : 'moved';
        content.append(note);
      }
      const heading = node('h3');
      const openStop = button(name, () => place(stop), 'stop-open');
      const opensChooser = lodgingPending && isLodgingStop(stop);
      openStop.setAttribute('aria-label', name + ' ' + start + (opensChooser ? ' ดูตัวเลือกที่พัก' : ' ดูรายละเอียดสถานที่'));
      openStop.setAttribute('aria-controls', opensChooser ? 'lodging-chooser' : 'place-panel');
      if (opensChooser) openStop.setAttribute('aria-haspopup', 'dialog');
      if (stop.id === focusedStop) openStop.setAttribute('aria-current', 'true');
      heading.append(openStop);
      content.append(heading, meta);
      const badge = forecast.badge(stop, state.selected, plan);
      if (badge) content.append(badge);
      const note = renderStopNote(stop.note, 'stop-note', stop.src);
      if (note) content.append(note);
      const actions = node('div', null, 'stop-actions');
      if (!preview && (stop.res?.todo || stop.res?.done || state.bookings[stop.id])) {
        const booked = reservationStatus(state, stop);
        const mark = button(booked === 'move' ? 'ต้องโทรเลื่อน' : booked === 'done' ? 'จองแล้ว ✓' : 'ทำเครื่องหมายว่าจองแล้ว', () => {
          setReservationDone(state, stop, booked !== 'done');
          render();
        });
        mark.dataset.status = booked;
        actions.append(mark);
      }
      if (actions.childElementCount) content.append(actions);
      if (menuDay) {
        if (!menuScope.menus.has(stop.id))
          menuScope.menus.set(stop.id, createStopMenu({
            city: plan.city, stop, day: menuDay, sample: state.sample === true, liveResearch, signal: menuScope.controller.signal,
          }));
        const menu = menuScope.menus.get(stop.id);
        if (menu) content.append(menu);
      }
      row.append(time, content);
      $('#itinerary').append(row);
    }
  }
  const todo = renderBookingTasks($('#reservations'), state, {
    run: task,
    rerender: render,
    resolveLodging: !state.sample && !state.demo ? chooseLodging : null,
    adjust: (command, day) => {
      switchView('plan');
      return adjust(command, day);
    },
  });
  $('#booking-count').textContent = todo ? '(' + todo + ')' : '';
  if (todo) $('#itinerary').append(button('ดูรายการที่ต้องติดต่อ ' + todo + ' รายการ', () => switchView('book')));
  forecast.renderStrip($('#alerts'), plan, state.selected);
  renderTripIntegrations($('#reservations'), state);
  const selected = day?.stops.find(stop => stop.id === focusedStop);
  const visible = (allDays ? plan.days : [day]).flatMap(d => d?.stops || []);
  const located = visible.filter(visitCoordinates).length;
  const mapStatus = $('#map-location-status');
  mapStatus.textContent = selected && !visitCoordinates(selected) ? 'ยังไม่มีพิกัดที่ยืนยันสำหรับ ' + (selected.name || selected.n)
    : located < visible.length ? 'มีพิกัด ' + located + ' จาก ' + visible.length + ' จุดแวะ' : '';
  mapStatus.hidden = !mapStatus.textContent;
  if ($('#planning-progress').hidden && !preview && !activeReplan && (!allDays || focusedStop)) recoverDayMap(plan, state.selected);
  if ($('#planning-progress').hidden) drawMap(
      allDays ? plan.days : [day],
      { ...state.routes, ...preview?.routes },
      place,
      preview && !allDays ? state.plan.days[state.selected] : null,
      focusedStop,
      undefined,
      allDays,
    );
}
window.addEventListener(
  'load',
  () => {
    if (state.plan) render();
  },
  { once: true },
);
function setItineraryExpanded(expanded) {
  const toggle = $('#itinerary-toggle');
  const label = expanded ? 'ย่อแผนเที่ยว' : 'เปิดแผนเที่ยว';
  $('#trip-sidebar').hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.querySelector('span').textContent = label;
}
$('#itinerary-toggle').onclick = () => setItineraryExpanded($('#trip-sidebar').hidden);
function switchView(next) {
  setItineraryExpanded(true);
  if (view !== next) closePlaceSheet($('#place-panel'), { restoreFocus: false });
  view = next;
  render();
}
for (const key of ['plan', 'book']) $('#' + key + '-tab').onclick = () => switchView(key);
$('#views').onkeydown = (event) => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    switchView(view === 'plan' ? 'book' : 'plan');
    $('#' + view + '-tab').focus();
  }
};
$('#tabs').onkeydown = (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const count = $('#tabs').children.length;
  if (!count) return;
  const next = (state.selected + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
  $('#tabs').children[next].click();
  $('#tabs').children[next].focus();
};
for (const [button, showAll] of [[$('#day-map'), false], [$('#whole-map'), true]]) {
  button.onclick = () => {
    if (allDays === showAll) return;
    allDays = showAll;
    focusedStop = null;
    closePlaceSheet($('#place-panel'), { restoreFocus: false });
    render();
  };
}
$('#reset-plan').onclick = () => {
  if (original && !busy) {
    state = structuredClone(original);
    updateTripLink();
    newTrip();
    allDays = false;
    render();
    status.textContent = 'กลับไปยังแผนแรกแล้ว';
  }
};
function place(stop) {
  const plan = preview?.plan || state.plan;
  const index = plan.days.findIndex(day => day?.stops?.some(item => item.id === stop.id));
  if (index >= 0) state.selected = index;
  allDays = false;
  if (view !== 'plan') view = 'plan';
  focusedStop = stop.id;
  if (!preview && !state.sample && !state.demo && needsLodgingChoice(plan) && isLodgingStop(stop)) {
    closePlaceSheet($('#place-panel'), { restoreFocus: false });
    chooseLodging();
    return;
  }
  render();
  if (matchMedia('(max-width: 860px)').matches) $('#map').scrollIntoView({ block: 'start' });
  else document.querySelector('.stop[data-focused="true"]')?.scrollIntoView({ block: 'nearest' });
  return openPlaceSheet({
    panel: $('#place-panel'),
    content: $('#place-panel-content'),
    stop,
    city: plan.city,
    day: plan.days[state.selected],
    setup: state.setup,
    stay: plan.flags?.stay,
    bookingStatus: state.bookings[stop.id]?.state,
    opener: $('#trip-sidebar').hidden
      ? document.activeElement?.closest('.map-pin') || $('#itinerary-toggle')
      : document.querySelector('.stop[data-focused="true"] .stop-open'),
    sample: state.sample === true,
    liveResearch: hasLiveService(),
  });
}
for (const selector of ['#open-setup', '#hero-setup'])
  $(selector).addEventListener('click', () => {
    if (state.plan && editingSetup !== state.setup) restoreForm(state.setup, state.plan.flags);
    setupDialog.showModal();
  });
$('#close-setup').addEventListener('click', () => setupDialog.close());
for (const [dir, title, placeName] of [
  ['arrive', 'ขาไป', 'ออกจาก'],
  ['depart', 'ขากลับ', 'กลับไปที่'],
]) {
  const area = node('fieldset', null, 'travel-leg');
  const options = node('div', null, 'travel-modes');
  for (const [value, label] of Object.entries(modes)) {
    const option = node('label', null, 'travel-mode');
    const radio = node('input');
    radio.type = 'radio';
    radio.name = dir + 'By';
    radio.value = value;
    radio.checked = value === 'undecided';
    option.append(radio, document.createTextNode(label));
    options.append(option);
  }
  const fields = node('div', null, 'travel-leg-fields');
  fields.append(
    field(placeName, dir + 'Place', { maxLength: 90 }),
    field(dir === 'arrive' ? 'เวลาถึง' : 'เวลาออก', dir + 'Time', { type: 'time' }),
  );
  area.append(node('legend', title), options, fields);
  $('#directions').append(area);
  withSuggestions(setupForm.elements[dir + 'Place'], 'transport');
}
const augmentSetup = installSetupExtras(setupForm, async () =>
  setupInput(await locate(setupForm.city.value.trim()).catch(() => null), true),
);
let nextMember = 0;
let editingSetup;
const memberWishReaders = new WeakMap();
function addWishEditor(row, savedWishes) {
  const editor = node('div', null, 'wish-editor');
  const label = node('label', 'อยากไปหรืออยากทำ');
  const limitNotice = node('small', null, 'muted');
  limitNotice.setAttribute('role', 'status');
  limitNotice.hidden = true;
  const list = node('ul', null, 'wish-list');
  list.setAttribute('aria-label', 'รายการที่อยากไปหรืออยากทำ');
  const entry = node('div', null, 'wish-entry');
  const input = node('input');
  input.type = 'text';
  input.name = 'wants';
  input.id = row.dataset.id + '-wish';
  label.htmlFor = input.id;
  const add = button('เพิ่ม', () => commit(pending()));
  entry.append(input, add);
  editor.append(label, list, entry, limitNotice);

  const limit = 5;
  const pending = () => input.value.split(/[,，]/).map((wish) => wish.trim()).filter(Boolean);
  function validate(wishes) {
    const remaining = limit - list.children.length;
    let message = '';
    if (wishes.length > remaining) message = 'เพิ่มได้อีก ' + remaining + ' รายการ';
    else if (wishes.some((wish) => wish.length > 120)) message = 'แต่ละรายการยาวได้ไม่เกิน 120 ตัวอักษร';
    input.setCustomValidity(message);
  }
  function refresh() {
    const size = list.children.length;
    const wishes = pending();
    const full = size === limit;
    input.disabled = full;
    input.placeholder = 'เช่น เดินตลาดเช้า';
    add.disabled = full || !wishes.length;
    entry.hidden = full;
    limitNotice.hidden = !full;
    limitNotice.textContent = full ? 'ครบ 5 รายการแล้ว ลบรายการเดิมเพื่อเพิ่มรายการใหม่' : '';
    list.hidden = !size;
    validate(wishes);
  }
  function appendWish(wish) {
    const item = node('li');
    const remove = button('×', () => {
      item.remove();
      refresh();
      input.focus();
    }, 'wish-remove');
    remove.setAttribute('aria-label', 'ลบ ' + wish);
    item.append(node('span', wish), remove);
    list.append(item);
  }
  function commit(wishes) {
    validate(wishes);
    if (!wishes.length || !input.reportValidity()) return;
    wishes.forEach(appendWish);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (input.disabled) list.lastElementChild.querySelector('button').focus();
    else input.focus();
  }
  for (const wish of savedWishes.slice(0, limit)) appendWish(wish);
  withSuggestions(input, 'place', (item) => commit([item.name]));
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    commit(pending());
  });
  refresh();
  memberWishReaders.set(row, () => {
    if (!input.checkValidity()) throw Error(input.validationMessage);
    return Array.from(list.children, (item) => item.firstElementChild.textContent).concat(pending());
  });
  return editor;
}
function addMember(name = '', wants = []) {
  if ($('#members').children.length >= 12) return;
  const row = node('div', null, 'member');
  do { row.dataset.id = 'member-' + ++nextMember; } while ([...$('#members').children].some(member => member.dataset.id === row.dataset.id));
  const info = node('div', null, 'fields');
  info.append(
    field('ชื่อ', 'person', { value: name, maxLength: 60 }),
    field('แพ้/ไม่ทาน', 'avoid', { maxLength: 120 }),
  );
  const limits = node('div', null, 'fields');
  limits.append(
    field('งบต่อคน (บาท)', 'budget', { type: 'number', min: 1 }),
    field('เดินได้ (กม./วัน)', 'walk', { type: 'number', min: 0.1 }),
  );
  limits.querySelector('[name=walk]').step = '.1';
  row.append(
    button('นำสมาชิกออก', () => {
      if ($('#members').children.length > 1) row.remove();
    }),
    info,
    limits,
    addWishEditor(row, wants),
    field('หมายเหตุ', 'note', { maxLength: 250 }),
  );
  $('#members').append(row);
  return row;
}
$('#add-member').addEventListener('click', () => addMember());
addMember('ผู้จัดทริป');
function addStay(nights) {
  const row = node('div', null, 'stay-row');
  const fields = node('div', null, 'fields');
  fields.append(
    field('ชื่อหรือที่อยู่ที่พัก', 'stayName', { maxLength: 120 }),
    field('จำนวนคืน', 'nights', { type: 'number', value: nights, min: 0, max: 6 }),
  );
  const dates = node('p', null, 'muted');
  row.append(
    fields,
    dates,
    button('นำที่พักออก', () => {
      if ($('#stay-rows').children.length < 2) return;
      const value = Number(row.querySelector('[name=nights]').value);
      row.remove();
      const last = $('#stay-rows').lastElementChild.querySelector('[name=nights]');
      last.value = Number(last.value) + value;
      updateStay();
    }),
  );
  $('#stay-rows').append(row);
  withSuggestions(row.querySelector('[name=stayName]'), 'stay');
  return row;
}
const candidateKindsLabel = includeHotels => includeHotels ? 'ร้านอาหาร ที่เที่ยว และโรงแรม' : 'ร้านอาหารและที่เที่ยว';
function updateStay(reset = false) {
  const nights = tripLength() - 1;
  const booked = setupForm.elements.stayMode.value === 'booked';
  const places = candidateKindsLabel(nights > 0 && !booked);
  $('#autonomy-ask-hint').textContent = 'เลือก' + places + 'ที่สนใจก่อนจัดแผน';
  $('#autonomy-auto-hint').textContent = 'ให้ Bop เลือก' + places + 'ให้ แก้แผนทีหลังได้';
  $('#stay-area').hidden = booked;
  $('#stays').hidden = !booked;
  $('#stays').disabled = !booked;
  const area = $('#stay-rows');
  if (!booked && !area.children.length) return;
  if (!area.children.length) addStay(nights);
  if (!nights && area.children.length > 1) while (area.children.length > 1) area.lastElementChild.remove();
  if (reset && area.children.length === 1)
    area.firstElementChild.querySelector('[name=nights]').value = nights;
  let cursor = 0;
  for (const row of area.children) {
    const input = row.querySelector('[name=nights]');
    input.parentElement.hidden = !nights;
    input.min = nights ? '1' : '0';
    if (!nights) input.value = 0;
    row.querySelector('button').hidden = area.children.length === 1;
    const start = Date.parse(setupForm.startDate.value) + cursor * dayMs;
    cursor += Number(input.value);
    row.querySelector('p').textContent =
      nights && Number.isFinite(start)
        ? calendar.format(start) +
          ' → ' +
          calendar.format(Date.parse(setupForm.startDate.value) + cursor * dayMs)
        : '';
  }
  $('#add-stay').hidden = !nights;
  $('#add-stay').disabled = area.children.length >= nights;
  $('#stay-total').textContent = nights ? 'รวม ' + cursor + ' / ' + nights + ' คืน' : '';
  $('#stay-total').classList.toggle('feedback', cursor !== nights);
}
$('#add-stay').addEventListener('click', () => {
  const area = $('#stay-rows');
  const existing = [...area.querySelectorAll('[name=nights]')];
  const hasSpace = existing.reduce((sum, input) => sum + Number(input.value), 0) < tripLength() - 1;
  const take = existing.findLast((input) => Number(input.value) > 1);
  if (!hasSpace && take) take.value = Number(take.value) - 1;
  if (hasSpace || take) addStay(1);
  updateStay();
});
$('#stay-rows').addEventListener('input', () => updateStay());
$('#stay-mode').addEventListener('change', () => updateStay());
const now = Date.now();
setupForm.startDate.value = ymd(now + dayMs);
setupForm.endDate.value = ymd(now + dayMs * 3);
for (const input of [setupForm.startDate, setupForm.endDate])
  input.addEventListener('change', () => {
    setupForm.endDate.min = setupForm.startDate.value;
    if (setupForm.endDate.value < setupForm.startDate.value)
      setupForm.endDate.value = setupForm.startDate.value;
    updateStay(true);
  });
async function locate(city, signal) {
  if (!city) return null;
  if (lookupCache.has(city)) return lookupCache.get(city);
  if (Object.hasOwn(presets, city)) {
    const [cc, currency, lat, lon] = presets[city];
    return { cc, currency, ll: [lat, lon] };
  }
  const response = await fetch('/api/city?q=' + encodeURIComponent(city), { signal });
  const found = response.ok ? await response.json() : null;
  if (found)
    found.currency =
      Object.values(presets).find((row) => row[0] === found.cc)?.[1] ??
      { US: 'USD', GB: 'GBP', MY: 'MYR', SG: 'SGD', CN: 'CNY', ID: 'IDR', AU: 'AUD', FR: 'EUR', DE: 'EUR' }[
        found.cc
      ] ??
      'THB';
  if (found) lookupCache.set(city, found);
  return found;
}
setupForm.city.addEventListener('change', async () => {
  const city = setupForm.city.value.trim();
  const found = await locate(city).catch(() => null);
  if (setupForm.city.value.trim() === city)
    $('#city-result').textContent = found
      ? [found.cc, found.currency].filter(Boolean).join(' · ')
      : 'ยังไม่พบเมืองนี้บนแผนที่';
});
function restoreForm(setup, flags) {
  editingSetup = setup;
  setupForm.elements.tripTitle.value = setup.title || '';
  for (const name of ['city', 'startDate', 'endDate']) {
    if (setup[name]) setupForm.elements[name].value = setup[name];
  }
  setupForm.elements.pace.value = ['chill', 'packed'].includes(setup.pace) ? setup.pace : 'normal';
  setupForm.elements.autonomy.value = setup.autonomy === 'ask' ? 'ask' : 'auto';
  setupForm.endDate.min = setup.startDate;
  setupForm.hasCar.checked = Boolean(setup.hasCar);
  const savedStays = setup.stay?.stays?.length ? setup.stay.stays
    : setup.stay?.name ? [{ ...setup.stay, nights: tripLength() - 1 }] : [];
  const booked = setup.stay?.mode === 'booked' || (!setup.stay?.mode && savedStays.some(stay => stay?.name?.trim()));
  setupForm.stayMode.value = booked ? 'booked' : 'auto';
  if (setup.cityLL) lookupCache.set(setup.city, {
    name: setup.city, ll: setup.cityLL, cc: setup.country, currency: setup.currency, airport: setup.cityAirport,
  });
  $('#city-result').textContent = [setup.country, setup.currency].filter(Boolean).join(' · ');
  $('#members').replaceChildren();
  for (const member of setup.members || []) {
    const row = addMember(member.name, Array.isArray(member.wants) ? member.wants : []);
    if (member.id) row.dataset.id = member.id;
    if (member.role) row.dataset.role = member.role;
    for (const [key, value] of Object.entries({
      budget: member.budget, walk: member.maxWalkKm, avoid: member.avoid, note: member.note,
    })) row.querySelector('[name=' + key + ']').value = value ?? '';
  }
  if (!$('#members').children.length) addMember();
  $('#stay-rows').replaceChildren();
  for (const stay of booked ? savedStays : []) {
    const input = addStay(stay.nights).querySelector('[name=stayName]');
    input.value = stay.name;
    if (stay.ll) selectedLocations.set(input, { name: stay.name, ll: stay.ll });
  }
  updateStay();
  augmentSetup.restore(setup, flags);
  $('#form-error').textContent = '';
  setupForm.dispatchEvent(new Event('input', { bubbles: true }));
}
function setupInput(found, transportOnly = false) {
  const nightsBetween = (Date.parse(setupForm.endDate.value) - Date.parse(setupForm.startDate.value)) / dayMs;
  if (!setupForm.city.value.trim()) throw Error('ระบุเมืองปลายทาง');
  if (!Number.isFinite(nightsBetween) || nightsBetween < 0 || nightsBetween >= 7)
    throw Error('เลือกวันเดินทางระหว่าง 1 ถึง 7 วัน');
  const dirs = {};
  for (const [key, place] of [
    ['arrive', 'from'],
    ['depart', 'to'],
  ])
    dirs[key] = {
      by: setupForm.elements[key + 'By'].value,
      [place]: setupForm.elements[key + 'Place'].value,
      placeLL: savedLocation(setupForm.elements[key + 'Place'])?.ll,
      time: setupForm.elements[key + 'Time'].value,
    };
  const stays = [...$('#stay-rows').children].map((row) => ({
    name: row.querySelector('[name=stayName]').value.trim(),
    nights: Number(row.querySelector('[name=nights]').value),
    ll: savedLocation(row.querySelector('[name=stayName]'))?.ll,
  }));
  const nights = tripLength() - 1;
  const booked = setupForm.stayMode.value === 'booked';
  if (!transportOnly && booked && nights) {
    for (const [index, row] of stays.entries()) {
      if (!row.name)
        throw new Error('ใส่ชื่อหรือที่อยู่ที่พักแถว ' + (index + 1) + ' หรือเลือก “ให้ Bop แนะนำ”');
      if (!Number.isInteger(row.nights) || row.nights < 1)
        throw new Error('ที่พักแถว ' + (index + 1) + ' ต้องมีอย่างน้อย 1 คืน');
    }
    const sum = stays.reduce((count, row) => count + row.nights, 0);
    if (sum !== nights)
      throw new Error(
        'จำนวนคืนรวม ' + sum + ' คืน ไม่ตรงกับทริป ' + nights + ' คืน แก้ให้รวมกันได้ ' + nights + ' คืน',
      );
  }
  const members = [...$('#members').children].map((row) => {
    const read = (key) => row.querySelector('[name=' + key + ']').value.trim();
    return {
      id: row.dataset.id,
      role: row.dataset.role,
      name: read('person'),
      avoid: read('avoid'),
      maxWalkKm: read('walk'),
      budget: read('budget'),
      wants: memberWishReaders.get(row)(),
      note: read('note'),
    };
  });
  if (transportOnly) members.forEach((m, i) => { m.name ||= 'สมาชิก ' + (i + 1); });
  if (!members.some((m) => m.name)) throw Error('ต้องมีสมาชิกที่ระบุชื่ออย่างน้อย 1 คน');
  return augmentSetup({
    title: setupForm.elements.tripTitle.value.trim() || setupForm.city.value.trim(),
    city: setupForm.city.value.trim(),
    cityLL: found?.ll,
    cityAirport: found?.airport,
    country: found?.cc,
    currency: found?.currency,
    startDate: setupForm.startDate.value,
    endDate: setupForm.endDate.value,
    ...dirs,
    hasCar: setupForm.hasCar.checked || Object.values(dirs).some((dir) => dir.by === 'drive'),
    stay: booked && stays.some((row) => row.name) ? { mode: 'booked', stays } : { mode: 'auto' },
    members,
    pace: setupForm.pace.value,
    autonomy: setupForm.autonomy.value,
  });
}
const planningPanel = $('#planning-progress');
function showPlanning(show) {
  planningPanel.hidden = !show;
  if (show) $('#map-title').classList.add('map-accessible-text');
  $('.trip-board').classList.toggle('planning-map', show);
  $('.trip-bar').inert = show;
  if (!show) {
    finishTrace($('#planning-steps'), activePlanning?.signal.aborted ? 'stopped' : 'done');
    $('#planning-phase').removeAttribute('data-waiting');
    $('#planning-retry').onclick = null;
    $('#planning-auto').onclick = null;
    $('#map-title').textContent = 'แผนที่ทริป';
  }
}
function planningPhase(phase, title, discoveryFailed = false) {
  const failed = phase === 'error';
  $('#cancel-plan').hidden = failed;
  $('#planning-edit').hidden = $('#planning-retry').hidden = !failed;
  $('#planning-auto').hidden = !discoveryFailed;
  finishTrace($('#planning-steps'), phase === 'error' ? 'stopped' : 'done');
  planningPanel.dataset.phase = phase;
  $('#planning-phase').toggleAttribute('data-waiting', ['preparing', 'candidates', 'planning'].includes(phase));
  $('#planning-phase').textContent = title;
}
function editPlanningDraft() {
  if (activePlanning) {
    activePlanning.abort();
    return;
  }
  showPlanning(false);
  render();
  if (!setupDialog.open) setupDialog.showModal();
  $('#setup-title').focus();
}
$('#cancel-plan').onclick = editPlanningDraft;
$('#planning-edit').onclick = editPlanningDraft;

async function generateTrip(input) {
  lodgingChooser.reset();
  archivedMap?.controller?.abort();
  const ctrl = new AbortController();
  activePlanning = ctrl;
  const signal = ctrl.signal;
  const totalDays = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / dayMs) + 1;
  const ready = new Map();
  const drafts = new Map();
  const routes = {};
  const known = lookupCache.get(input.city) || localSuggestions(input.city, { kind: 'city' }).find((hit) => hit.name === input.city);
  input.cityLL ||= known?.ll || presets[input.city]?.slice(2);
  const draftMap = (days, openCandidate, caption = input.city) => {
    $('#map-title').textContent = caption;
    drawMap(days, routes, openCandidate, undefined, undefined, { cityLL: input.cityLL });
  };
  const onStep = (text) => {
    if (activePlanning !== ctrl || signal.aborted || typeof text !== 'string' || !text.trim()) return;
    $('#planning-phase').removeAttribute('data-waiting');
    appendTrace($('#planning-steps'), text);
  };
  const showDays = () => {
    $('#planning-day-count').textContent = 'จัดแล้ว ' + ready.size + ' จาก ' + totalDays + ' วัน';
    $('#planning-day-meter').value = ready.size;
    const list = $('#planning-days');
    list.replaceChildren();
    for (const [index, day] of [...ready].sort(([a], [b]) => a - b)) {
      const row = node('li', 'วันที่ ' + (index + 1) + (day.title ? ' · ' + day.title : ''));
      row.value = index + 1;
      const places = day.stops.slice(0, 3).map((stop) => stop.name || stop.n).filter(Boolean);
      if (places.length) row.append(node('small', places.join(' · ')));
      list.append(row);
    }
  };
  if (setupDialog.open) setupDialog.close();
  status.textContent = '';
  $('#planning-context').textContent = input.title || input.city;
  $('#planning-steps').replaceChildren();
  $('#planning-day-meter').max = totalDays;
  $('#planning-day-progress').hidden = true;
  $('#planning-error').hidden = true;
  planningPhase('preparing', 'กำลังเตรียมทริป');
  showDays();
  showPlanning(true);
  closePlaceSheet($('#place-panel'), { restoreFocus: false });
  $('#map-title').textContent = input.city;
  drawMap([], {}, undefined, undefined, undefined, { cityLL: input.cityLL, restart: true });
  window.scrollTo(0, 0);
  $('#planning-phase').focus({ preventScroll: true });
  try {
    const lookup = input.cityLL ? Promise.resolve(known) : locate(input.city, signal).catch(() => null);
    const [health] = await Promise.all([checkHealth(signal), lookup.then((found) => {
      signal.throwIfAborted();
      if (found) {
        input.cityLL = found.ll;
        input.country ||= found.cc;
        input.currency ||= found.currency;
        input.cityAirport ||= found.airport;
        draftMap([]);
      }
    })]);
    signal.throwIfAborted();
    if (!health?.ai) throw Error($('#readiness').textContent);
    if (input.autonomy === 'ask' && !input.picks) {
      const includeHotels = totalDays > 1 && input.stay?.mode !== 'booked';
      planningPhase('candidates', 'กำลังค้นหา' + candidateKindsLabel(includeHotels) + 'ให้เลือก');
      const found = await api('/api/plan/candidates', { setup: input }, undefined, { signal, onStep });
      signal.throwIfAborted();
      input.picks = await chooseCandidates({
        dialog: $('#planning-survey'), result: found, partySize: input.members.length, signal, includeHotels,
        reopen: $('#planning-reopen'),
        findMore: (refresh, refreshSignal) =>
          api('/api/plan/candidates', { setup: input, refresh }, undefined, { signal: refreshSignal, onStep }),
        onQuestion(question, openCandidate) {
          planningPhase('choosing', 'เลือกสถานที่สำหรับทริป');
          const stops = question.options.filter((place) => coordinates(place.ll));
          draftMap([{ stops }], openCandidate, input.city + ' · ตัวเลือกสถานที่');
        },
      });
      signal.throwIfAborted();
      const selected = input.picks.must.filter((place) => coordinates(place.ll));
      draftMap([{ stops: selected }], undefined, selected.length ? input.city + ' · สถานที่ที่เลือก' : input.city);
    }
    planningPhase('planning', 'กำลังจัดแผนรายวัน');
    $('#planning-day-progress').hidden = false;
    const updateMap = (event) => {
      if (signal.aborted || activePlanning !== ctrl || !Number.isInteger(event.index) ||
          event.index < 0 || event.index >= totalDays || !Array.isArray(event.day?.stops)) return;
      if (event.type === 'day') {
        ready.set(event.index, event.day);
        showDays();
      } else if (ready.has(event.index)) return;
      drafts.set(event.index, event.day);
      Object.assign(routes, event.routes);
      const days = Array.from({ length: totalDays }, (_, i) => drafts.get(i));
      draftMap(days);
    };
    const result = await api('/api/plan', { setup: input }, updateMap, { signal, onStep, onMap: updateMap });
    signal.throwIfAborted();
    if (!Array.isArray(result.plan?.days) || result.plan.days.length !== totalDays ||
        !result.plan.days.every((day) => Array.isArray(day?.stops)))
      throw Error('Bop ส่งแผนไม่ครบ กรุณาลองใหม่');
    state = {
      plan: result.plan, routes: result.routes, setup: result.plan.setup,
      selected: 0, demo: false, bookings: {}, cancellations: [], usage: result.usage,
      integrationKey: newTripIntegrationKey(),
      localTripId: result.localTripId,
    };
    showPlanning(false);
    updateTripLink();
    newTrip();
    presentSummary(result.summary);
    render();
    $('#plan-tab').focus({ preventScroll: true });
    forecast.refresh();
  } catch (error) {
    if (signal.aborted) {
      showPlanning(false);
      render();
      if (!setupDialog.open) setupDialog.showModal();
      $('#setup-title').focus();
    } else {
      const discoveryFailed = planningPanel.dataset.phase === 'candidates';
      planningPhase('error', discoveryFailed ? 'หาตัวเลือกไม่สำเร็จ' : 'สร้างแผนทริปไม่สำเร็จ', discoveryFailed);
      $('#planning-error').textContent = error.message || 'กรุณาลองอีกครั้ง';
      $('#planning-error').hidden = false;
      $('#planning-retry').onclick = () => task(() => generateTrip(input));
      if (discoveryFailed) $('#planning-auto').onclick = () => task(() => generateTrip({ ...input, autonomy: 'auto' }));
      $('#planning-retry').focus({ preventScroll: true });
    }
  } finally {
    if (activePlanning === ctrl) activePlanning = null;
  }
}
setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  $('#form-error').textContent = '';
  task(async () => {
    let input;
    try {
      input = setupInput(savedLocation(setupForm.city));
    } catch (error) {
      $('#form-error').textContent = error.message;
      $('#form-error').scrollIntoView({ block: 'center' });
      return;
    }
    await generateTrip(input);
  });
});
function setChatExpanded(expanded) {
  const toggle = $('#chat-toggle');
  const phase = $('#chat-response').dataset.state;
  const label = expanded ? 'ย่อแผงคุยกับ Bop' : phase === 'decision' ? 'ดูตัวเลือกจาก Bop'
    : phase === 'running' ? 'ดูความคืบหน้าจาก Bop' : 'ดูผลจาก Bop';
  $('#chat-content').hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.querySelector('span').textContent = expanded ? 'ย่อแผง' : label;
}
$('#chat-toggle').onclick = () => setChatExpanded($('#chat-content').hidden);
function clearChat() {
  activeReplan?.abort();
  activeReplan = null;
  $('#chat-response').hidden = true;
  setChatExpanded(true);
  $('#chat-steps').replaceChildren();
  $('#chat-retry').onclick = null;
  $('#chat-result').hidden = true;
  $('#chat-result').open = false;
  $('#chat-line').replaceChildren();
  $('#chat-review').replaceChildren();
  $('#options').replaceChildren();
}
function chatState(phase, title, detail = '') {
  const response = $('#chat-response');
  response.dataset.state = phase;
  setChatExpanded(!$('#chat-content').hidden);
  response.hidden = false;
  $('#chat-state').textContent = title;
  $('#chat-description').textContent = detail;
  $('#chat-description').hidden = !detail;
  $('#chat-cancel').hidden = phase !== 'running';
  $('#chat-dismiss').hidden = phase === 'running' || phase === 'decision';
  $('#chat-retry').hidden = phase !== 'error';
  $('#chat-state').toggleAttribute('data-waiting', phase === 'running' && !$('#chat-steps').childElementCount);
  if (phase !== 'running') finishTrace($('#chat-steps'), ['error', 'cancelled'].includes(phase) ? 'stopped' : 'done');
  response.scrollTop = 0;
}
function chatStep(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  $('#chat-state').removeAttribute('data-waiting');
  appendTrace($('#chat-steps'), text);
}
$('#chat-cancel').onclick = () => activeReplan?.abort();
$('#chat-dismiss').onclick = () => {
  clearChat();
  $('#command').focus();
};
function applyOption(option, routes, { summary = '', fromLineVote = false, selected = state.selected } = {}) {
  closePlaceSheet($('#place-panel'), { restoreFocus: false });
  preview = null;
  history.push(structuredClone(state));
  const { bookings, cancellations } = reconcileReservations(state, option.plan);
  state = {
    ...state,
    selected,
    plan: option.plan,
    setup: option.plan.setup,
    ...(option.usage?.provider && option.usage.provider !== 'fake' ? { demo: false, sample: false, usage: option.usage } : {}),
    routes: { ...state.routes, ...routes },
    bookings,
    cancellations,
  };
  pendingVotes = null;
  $('#options').replaceChildren();
  $('#alerts').replaceChildren();
  state.localTripId = option.localTripId || state.localTripId;
  bindTripIntegrations(state);
  updateTripLink();
  presentSummary(option.line);
  const details = [...new Set([option.title, summary || option.head])].filter(Boolean);
  chatState('applied', 'ปรับแผนแล้ว', details.join(' · '));
  renderPlanReview($('#chat-review'), history.at(-1).plan, option);
  renderRepairOutcome($('#chat-review'), option.plan.repairOutcome);
  $('#chat-result').hidden = false;
  renderAppliedLine($('#chat-line'), history.at(-1), state, option.line, fromLineVote, () => switchView('book'));
  if (document.activeElement !== $('#command')) $('#chat-state').focus({ preventScroll: true });
  render();
  forecast.refresh();
}
async function adjust(command, day = state.selected) {
  lodgingChooser.reset();
  if (!state.plan) return;
  clearChat();
  preview = pendingVotes = null;
  focusedStop = null;
  allDays = false;
  closePlaceSheet($('#place-panel'), { restoreFocus: false });
  switchView('plan');
  status.textContent = '';
  $('#chat-command').textContent = command;
  chatState('running', 'Bop กำลังปรับแผน…');
  $('#chat-response').scrollIntoView({ block: 'nearest' });
  const pinnedPlan = structuredClone(state.plan);
  for (const stop of pinnedPlan.days.flatMap((d) => d.stops))
    if (state.bookings[stop.id]?.state === 'done') stop.res = { ...stop.res, done: true };
  const input = { plan: pinnedPlan, setup: state.setup, command, day };
  const ctrl = new AbortController();
  activeReplan = ctrl;
  const onStep = (text) => {
    if (activeReplan === ctrl && !ctrl.signal.aborted) chatStep(text);
  };
  let result;
  try {
    result = await api('/api/replan', input, undefined, { signal: ctrl.signal, onStep });
    ctrl.signal.throwIfAborted();
    if (!Array.isArray(result.options) || !result.options.length ||
        !result.options.every((option) => option?.plan?.days?.length && option.plan.days.every((d) => Array.isArray(d?.stops)))) {
      throw Error('ยังไม่ได้รับแผนที่สมบูรณ์');
    }
  } catch (error) {
    if (activeReplan !== ctrl) return;
    if (ctrl.signal.aborted) chatState('cancelled', 'ยกเลิกคำขอแล้ว');
    else {
      chatState('error', 'ปรับแผนไม่สำเร็จ', clean(error.message) || 'กรุณาลองอีกครั้ง');
      $('#chat-retry').onclick = () => task(() => adjust(command, day));
    }
    return;
  } finally {
    if (activeReplan === ctrl) activeReplan = null;
  }
  for (const option of result.options) option.usage = result.usage;
  const selected = Number.isInteger(result.day) ? result.day : state.selected;
  if (!result.needs_vote) {
    applyOption(result.options[0], result.routes, { summary: result.summary, selected });
    return;
  }
  pendingVotes = result;
  chatState('decision', 'อยากใช้แผนไหน?', result.vote_reason || result.summary);
  const area = $('#options');
  const choices = node('div', null, 'chat-choices');
  const viewing = node('p', null, 'preview-status');
  viewing.setAttribute('role', 'status');
  area.replaceChildren(viewing, choices);
  if (document.activeElement !== $('#command')) $('#chat-state').focus({ preventScroll: true });
  const previewDays = new Map();
  let originalDay = state.selected, originalAllDays = allDays;
  const currentPlan = button('ดูแผนปัจจุบัน', () => showPreview(null));
  function showPreview(option, reveal = true) {
    if (pendingVotes !== result) return;
    if (!preview && option) {
      originalDay = state.selected;
      originalAllDays = allDays;
    }
    preview = option ? { key: option.key, plan: option.plan, routes: result.routes } : null;
    state.selected = option ? previewDays.get(option.key) : originalDay;
    allDays = option ? false : originalAllDays;
    focusedStop = null;
    closePlaceSheet($('#place-panel'), { restoreFocus: false });
    for (const control of choices.querySelectorAll('[data-preview]')) {
      const key = control.dataset.preview, active = key === option?.key;
      control.setAttribute('aria-pressed', String(active));
      control.textContent = active ? 'กลับไปดูแผนปัจจุบัน' : 'ดูตัวอย่างแผน ' + key;
    }
    currentPlan.hidden = !option;
    viewing.textContent = option ? 'กำลังดูตัวอย่างแผน ' + option.key : 'กำลังดูแผนปัจจุบัน';
    switchView('plan');
    if (reveal) {
      const title = $('#itinerary .preview-note strong');
      title.focus({ preventScroll: true });
      title.scrollIntoView({ block: 'start' });
    }
  }
  const ballot = {};
  const localActions = [];
  let syncChoice, choosingLocal = false;
  function applyDecision(option, fromLineVote) {
    if (preview) state.selected = originalDay;
    applyOption(option, result.routes, { selected: previewDays.get(option.key), fromLineVote });
  }
  async function chooseLocal(option) {
    if (pendingVotes !== result || choosingLocal) return;
    choosingLocal = true;
    const confirmed = await syncChoice?.(option);
    if (pendingVotes !== result) return;
    applyDecision(confirmed || option, Boolean(confirmed));
    setBusy(false);
  }
  for (const option of result.options) {
    const row = node('article', null, 'option');
    const heading = node('h3', option.key + ' · ' + option.title);
    row.append(heading);
    if (option.head && option.head !== option.title) row.append(node('p', option.head));
    const actions = node('div', null, 'inline');
    const compare = button('ดูตัวอย่างแผน ' + option.key, () => showPreview(preview?.key === option.key ? null : option));
    compare.dataset.preview = option.key;
    compare.setAttribute('aria-controls', 'itinerary map');
    actions.append(compare);
    row.append(actions);
    const { changes } = renderPlanReview(row, state.plan, option);
    const days = changes.map(change => (change.after || change.before).day - 1).filter(i => i < option.plan.days.length);
    previewDays.set(option.key, days.includes(selected) ? selected : days[0] ?? Math.min(selected, option.plan.days.length - 1));
    if (option.line) row.append(lineMessageBubble(option.line, 'ข้อความ LINE หากเลือกแผนนี้'));
    renderRepairOutcome(row, option.plan.repairOutcome);
    choices.append(row);
    localActions.push(() => actions.append(button('ใช้แผน ' + option.key, () => chooseLocal(option), 'primary')));
  }
  area.append(currentPlan);
  const local = node('div');
  local.hidden = true;
  const showLocalVote = (sync) => {
    if (!local.hidden || pendingVotes !== result) return;
    syncChoice = sync;
    for (const show of localActions) show();
    local.hidden = false;
  };
  const linkedVote = renderLineVote(area, state, result, (option) => applyDecision(option, true), showLocalVote);
  if (!linkedVote) showLocalVote();
  showPreview(linkedVote ? result.options[0] : null, false);
  area.append(local);
  local.append(button('คงแผนเดิม', () => {
    if (preview) {
      state.selected = originalDay;
      allDays = originalAllDays;
    }
    focusedStop = null;
    closePlaceSheet($('#place-panel'), { restoreFocus: false });
    pendingVotes = preview = null;
    area.replaceChildren();
    render();
    chatState('kept', 'ใช้กำหนดการเดิม');
    $('#chat-state').focus({ preventScroll: true });
  }));
  local.append(node('h3', 'โหวตแผนกับเพื่อน'));
  const selectedLabels = Object.fromEntries(result.options.map((option) => [option.key, option.title]));
  for (const member of state.setup.members) {
    const voter = selectField(member.name, member.id, { '': 'ยังไม่ได้โหวต', ...selectedLabels }, '');
    voter.addEventListener('change', (event) => {
      ballot[member.id] = event.target.value;
    });
    local.append(voter);
  }
  const tie = selectField(
    'ตัวเลือกกรณีคะแนนเสมอ (ผู้จัดทริป)',
    'tie',
    { '': 'เลือกเมื่อคะแนนเสมอ', ...selectedLabels },
    '',
  );
  local.append(
    tie,
    button(
      'ใช้ผลโหวต',
      () => {
        const counts = result.options
          .map((option) => [option.key, Object.values(ballot).filter((vote) => vote === option.key).length])
          .sort((a, b) => b[1] - a[1]);
        if (Object.values(ballot).filter(Boolean).length < state.setup.members.length) {
          voteStatus.textContent = 'รอสมาชิกโหวตให้ครบ';
          return;
        }
        const key = counts[0][1] === counts[1][1] ? tie.querySelector('select').value : counts[0][0];
        const selected = pendingVotes?.options.find((option) => option.key === key);
        if (selected) void chooseLocal(selected);
        else voteStatus.textContent = 'คะแนนเสมอ ให้ผู้จัดทริปเลือก';
      },
      'primary',
    ),
  );
  const voteStatus = node('p', '', 'feedback');
  voteStatus.setAttribute('role', 'status');
  local.append(voteStatus);
}
$('#replan').addEventListener('submit', (event) => {
  event.preventDefault();
  const command = $('#command').value.trim();
  if (command && !busy) {
    $('#command').value = '';
    task(() => adjust(command));
  }
});
$('#undo').addEventListener('click', () => {
  if (!history.length) return;
  closePlaceSheet($('#place-panel'), { restoreFocus: false });
  state = history.pop();
  updateTripLink();
  preview = null;
  pendingVotes = null;
  forecast.refresh();
  clearChat();
  $('#alerts').replaceChildren();
  status.textContent = 'ย้อนกลับเป็นแผนก่อนหน้าแล้ว';
  setBusy(false);
  render();
});
bindWorkspace(setupForm);
render();
checkHealth();
fetch('/api/config').catch(() => {});
const localTrip = /^#trip=([0-9a-f-]{36})$/.exec(location.hash);
if (localTrip)
  task(async () => {
    const response = await fetch('/api/local-trips/' + localTrip[1]);
    if (!response.ok) {
      $('#form-error').textContent = response.status === 404
        ? 'ไม่พบแผนที่บันทึกไว้ในเครื่องนี้แล้ว เริ่มสร้างทริปใหม่ได้'
        : 'เปิดทริปที่บันทึกไว้ไม่ได้ ลองโหลดหน้าอีกครั้ง';
      setupDialog.showModal();
      return;
    }
    const saved = await response.json();
    state = {
      plan: saved.plan,
      setup: saved.plan.setup,
      routes: saved.routes || {},
      selected: 0,
      demo: false,
      usage: saved.usage,
      bookings: {},
      cancellations: [],
    };
    state.localTripId = localTrip[1];
    newTrip();
    archivedMap = { id: localTrip[1], plan: state.plan, checked: new Set() };
    presentSummary(saved.summary);
    render();
    forecast.refresh();
  });
else setupDialog.showModal();
