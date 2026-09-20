import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardingGuidance,
  boardingHelpQuestion,
  boardingMapUrl,
  publicStopNumber,
  spokenStopNumber,
} from '../lib/boarding-guidance.ts';
import { departureGuidance } from '../lib/departure-guidance.ts';
import { defaultSettings, stampArrivals } from '../lib/journey.ts';
import { demoPlaces } from '../lib/trip-planning.ts';

const now = 1_800_000_000_000;
// Synthetic route fixture; coordinates/numbers are not travel instructions.
const trip = {
  id: 'test-route',
  route: '707',
  direction: '시청.교육청 방향',
  nextStopName: '한밭중네거리',
  walkToStopMinutes: 4,
  totalMinutes: 20,
  transfers: 0,
  boardingStop: {
    id: 'internal-123',
    name: '대전역',
    number: '01240',
    latitude: 36.33254,
    longitude: 127.43213,
  },
  alightingStop: { name: '시청.교육청' },
};
const snapshot = {
  origin: demoPlaces[0],
  destination: demoPlaces[1],
  trip,
  settings: defaultSettings,
  tripBusy: false,
  busesBusy: false,
  tripError: null,
  tripMode: 'live',
  dataMode: 'live',
  lastUpdatedAt: now,
  buses: stampArrivals(
    [{ id: 'bus', route: '707', etaMinutes: 20, lowFloor: true }],
    now,
  ),
};

test('boarding guidance names stop, direction, public number, next stop and alighting', () => {
  const text = boardingGuidance(trip, true);
  for (const part of [
    '대전역 정류장',
    '공 일 이 사 공',
    '시청.교육청 방향 707번 저상버스',
    '다음 정류장은 한밭중네거리',
    '시청.교육청에서 내려요',
  ])
    assert.ok(text.includes(part));
  assert.ok(!text.includes('internal-123'));
});

test('public numbers preserve leading zeroes and are spoken digit by digit', () => {
  assert.equal(publicStopNumber(' 01240 '), '01240');
  assert.equal(publicStopNumber(12400), '12400');
  assert.equal(publicStopNumber('01-240'), '01-240');
  assert.equal(spokenStopNumber('01-240'), '공 일 다시 이 사 공');
  for (const value of [
    null,
    undefined,
    '0',
    '00000',
    -3,
    {},
    'DJB8001418',
    '1234567890123',
  ])
    assert.equal(publicStopNumber(value), undefined);
});

test('arrival failures still describe the stop but never claim a low-floor bus or departure time', () => {
  for (const patch of [
    { dataMode: 'unavailable' },
    { lastUpdatedAt: null },
    { lastUpdatedAt: now - 91_000 },
    { lastUpdatedAt: now + 6_000 },
    { busesBusy: true },
    { buses: [] },
    { dataMode: 'demo' },
  ]) {
    const text = departureGuidance({ ...snapshot, ...patch }, now);
    for (const part of [
      '대전역 정류장',
      '공 일 이 사 공',
      '시청.교육청 방향 707번 버스',
      '한밭중네거리',
    ])
      assert.ok(text.includes(part));
    assert.doesNotMatch(
      text,
      /저상버스를 타세요|\d+분 뒤.*출발하세요|지금 출발하세요/,
    );
    assert.ok(text.length <= 600);
  }
});

test('valid arrival recommendation contains boarding details and calculated time', () => {
  const text = departureGuidance(snapshot, now);
  assert.match(text, /12분 뒤/);
  assert.match(
    text,
    /대전역 정류장.*시청.교육청 방향 707번 저상버스.*한밭중네거리/,
  );
});

test('unconfirmed or changing routes never read stale stop details', () => {
  for (const patch of [
    { tripBusy: true },
    { trip: null },
    { tripMode: 'unavailable', tripError: '경로 오류' },
  ]) {
    assert.doesNotMatch(
      departureGuidance({ ...snapshot, ...patch }, now),
      /대전역|01240|한밭중네거리/,
    );
  }
});

test('missing metadata omits unknown numbers and next stops without inventing a street side', () => {
  const minimal = {
    ...trip,
    nextStopName: undefined,
    boardingStop: { id: 'internal-123', name: '대전역' },
  };
  for (const text of [
    boardingGuidance(minimal),
    boardingHelpQuestion(minimal),
  ]) {
    assert.doesNotMatch(
      text,
      /undefined|internal-123|정류장 번호|다음 정류장|왼쪽|오른쪽|횡단보도/,
    );
  }
  assert.equal(boardingMapUrl(minimal.boardingStop), null);
});

test('map links target the boarding coordinates, encode labels and reject missing/invalid points', () => {
  const url = boardingMapUrl({ ...trip.boardingStop, name: '대전역 / A,B' });
  assert.equal(
    url,
    'https://map.kakao.com/link/map/' +
      encodeURIComponent('대전역 / A,B') +
      ',36.33254,127.43213',
  );
  for (const patch of [
    { latitude: NaN },
    { latitude: 91 },
    { longitude: Infinity },
    { longitude: -181 },
    { latitude: undefined },
    { id: 'demo-sinchon' },
  ])
    assert.equal(boardingMapUrl({ ...trip.boardingStop, ...patch }), null);
});

test('asking for help shows readable digits and uses spoken digits for Gemini', () => {
  assert.match(boardingHelpQuestion(trip), /정류장 번호는 01240/);
  assert.match(
    boardingHelpQuestion(trip, true),
    /정류장 번호는 공 일 이 사 공/,
  );
  for (const text of [
    boardingHelpQuestion(trip),
    boardingHelpQuestion(trip, true),
  ]) {
    assert.match(
      text,
      /대전역.*시청.교육청 방향 707번.*한밭중네거리.*알려주실 수 있나요/,
    );
  }
});

test('demo route details remain explicitly demo even when arrivals are unavailable', () => {
  assert.match(
    departureGuidance(
      { ...snapshot, tripMode: 'demo', dataMode: 'unavailable' },
      now,
    ),
    /^체험용 안내예요. 실제 이동에 사용하지 마세요/,
  );
});
