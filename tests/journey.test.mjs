import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings,
  restoreSettings,
  stampArrivals,
  getRecommendation,
  createAlertPlan,
  dueAlert,
  travelMinutesForRoute,
} from '../lib/journey.ts';
import {
  parseSpokenRouteQueries,
  uniquePlaceMatch,
} from '../lib/voice-route.ts';
import { extractMinutes } from '../lib/voice-numbers.ts';

const start = Date.UTC(2026, 8, 13, 1);
const settings = { ...defaultSettings, automaticTravelTime: false };
const feed = stampArrivals(
  [
    {
      id: 'bus-a',
      route: '271',
      etaMinutes: 18,
      lowFloor: true,
      stopsAway: 4,
      congestion: '정보 없음',
    },
  ],
  start,
);

test('ambiguous spoken places require selection instead of taking the first result', () => {
  assert.equal(
    uniquePlaceMatch('중앙병원', [
      { name: '중앙병원', id: 'a' },
      { name: '중앙병원', id: 'b' },
    ]),
    null,
  );
  assert.equal(
    uniquePlaceMatch('서울역', [
      { name: '서울역', id: 'station' },
      { name: '서울역 카페', id: 'cafe' },
    ]).id,
    'station',
  );
});

test('elapsed time reduces ETA without moving the absolute departure time', () => {
  const first = getRecommendation(feed, settings, start).recommended;
  const later = getRecommendation(
    feed,
    settings,
    start + 5 * 60_000,
  ).recommended;
  assert.equal(first.etaMinutes, 18);
  assert.equal(later.etaMinutes, 13);
  assert.equal(
    createAlertPlan(first, settings).departAt,
    createAlertPlan(later, settings).departAt,
  );
});

test('a bus no longer reachable with the full preparation time is excluded', () => {
  assert.equal(
    getRecommendation(feed, settings, start + 7 * 60_000).recommended,
    null,
  );
});

test('second-accurate arrivals do not gain artificial time by rounding up', () => {
  const buses = stampArrivals(
    [{ ...feed[0], etaSeconds: 719, etaMinutes: 12 }],
    start,
  );
  assert.equal(getRecommendation(buses, settings, start).recommended, null);
});

test('voice preferences do not move scheduled preparation or departure', () => {
  const plan = createAlertPlan(feed[0], settings);
  const changed = createAlertPlan(feed[0], {
    ...settings,
    voiceRate: 0.8,
    voiceURI: 'other',
  });
  assert.equal(plan.prepareAt, changed.prepareAt);
  assert.equal(plan.departAt, changed.departAt);
  assert.equal(plan.settingsKey, changed.settingsKey);
});

test('each alert fires once and missed departure does not instruct a late departure', () => {
  const plan = createAlertPlan(feed[0], settings);
  assert.equal(
    dueAlert(plan, plan.prepareAt, { prepare: false, depart: false }),
    'prepare',
  );
  assert.equal(
    dueAlert(plan, plan.prepareAt, { prepare: true, depart: false }),
    null,
  );
  assert.equal(
    dueAlert(plan, plan.departAt, { prepare: true, depart: false }),
    'depart',
  );
  assert.equal(
    dueAlert(plan, plan.departAt, { prepare: true, depart: true }),
    null,
  );
  assert.equal(
    dueAlert(plan, plan.departAt + 31_000, { prepare: true, depart: false }),
    'expired',
  );
});

test('settings round-trip preserves choices while rejecting invalid values', () => {
  const chosen = {
    ...settings,
    preparationMinutes: 2,
    voiceRate: 0.88,
    voiceAlerts: false,
  };
  assert.deepEqual(restoreSettings(JSON.parse(JSON.stringify(chosen))), chosen);
  assert.equal(
    restoreSettings({ travelMinutes: -100, voiceRate: 5 }).travelMinutes,
    7,
  );
  assert.equal(restoreSettings(null).voiceRate, defaultSettings.voiceRate);
});

test('route travel time adapts to pace; manual override stays manual', () => {
  assert.equal(travelMinutesForRoute(defaultSettings, 20), 30);
  assert.equal(travelMinutesForRoute(settings, 20), 7);
  assert.equal(travelMinutesForRoute(defaultSettings, undefined), 7);
});

test('spoken time updates are not sent to place search', () => {
  for (const text of ['이동 시간 15분으로 해줘', '준비 오 분', '여유 99분']) {
    assert.deepEqual(parseSpokenRouteQueries(text), {
      originQuery: '',
      destinationQuery: '',
    });
  }
  assert.equal(
    extractMinutes('이동 시간 15분으로 해줘', '이동(?:\\s*시간)?'),
    15,
  );
  assert.equal(extractMinutes('준비 오 분', '준비(?:\\s*시간)?'), 5);
  assert.equal(extractMinutes('준비 삼십 분', '준비(?:\\s*시간)?'), 30);
});

test('voice routes support current location, destination-only and corrections', () => {
  assert.deepEqual(parseSpokenRouteQueries('현재 위치에서 서울역까지'), {
    originQuery: '현재 위치',
    destinationQuery: '서울역',
  });
  assert.deepEqual(parseSpokenRouteQueries('천안역'), {
    originQuery: '',
    destinationQuery: '천안역',
  });
  assert.deepEqual(
    parseSpokenRouteQueries('서울역에서 강남역 말고 홍대입구역까지'),
    { originQuery: '서울역', destinationQuery: '홍대입구역' },
  );
});
