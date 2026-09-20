import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagoClient } from '../lib/tago-client.ts';
import {
  findTagoRouteMatch,
  matchOrderedRoute,
} from '../lib/tago-route-match.ts';
import { GET as getRoutes } from '../app/api/routes/route.ts';
import { GET as getBuses } from '../app/api/buses/route.ts';

const segment = {
  route: '707',
  stopNames: ['대전역', '한밭중네거리', '시청.교육청'],
  boardingPoint: [127.432123, 36.332726],
  alightingPoint: [127.3835, 36.351395],
};
const routeId = 'DJB30300152';
const stop = (id, name, order, direction, coords) => ({
  routeid: routeId,
  nodeid: id,
  nodenm: name,
  nodeord: order,
  updowncd: direction,
  gpslong: coords[0],
  gpslati: coords[1],
});
// Small fixture, not a full real-world route: opposite platforms are deliberately close.
const outbound = [
  {
    ...stop('outbound', '대전역', 2, 0, [127.43213, 36.33254]),
    nodeno: '01240',
  },
  stop('middle', '한밭중네거리', 3, 0, [127.42679, 36.336952]),
  stop('cityhall-out', '시청.교육청', 4, 0, segment.alightingPoint),
];
const inbound = [
  stop('cityhall-in', '시청.교육청', 5, 1, [127.38355, 36.35139]),
  stop('middle-in', '한밭중네거리', 6, 1, [127.4267, 36.3369]),
  stop('inbound', '대전역', 7, 1, segment.boardingPoint),
];
const nearby = [
  { ...inbound[2], citycode: 25 },
  { ...outbound[0], citycode: 25 },
  { ...inbound[2], nodeid: 'other-city', citycode: 12 },
];
const route = { routeid: routeId, routeno: 707 };
function tagoResponse(items, total = items.length) {
  return Response.json({
    response: {
      header: { resultCode: '00' },
      body: {
        totalCount: total,
        items: { item: items.length === 1 ? items[0] : items },
      },
    },
  });
}
function mockClient(options = {}) {
  return {
    async list(operation, params) {
      if (operation === 'nearby') return options.nearby ?? nearby;
      if (operation === 'routes')
        return params.cityCode === '25'
          ? [route, { ...route, routeid: 'not-707', routeno: 1707 }]
          : [];
      if (operation === 'routeStops') {
        assert.equal(params.routeId, routeId);
        return options.stops ?? [...inbound, ...outbound];
      }
      throw new Error('Unexpected operation');
    },
  };
}
function configure(t, overrides = {}) {
  for (const [key, value] of Object.entries({
    TAGO_BUS_API_KEY: 'test-key-not-real',
    KAKAO_REST_API_KEY: 'test-kakao-not-real',
    TAGO_CITY_CODE: '',
    TAGO_NODE_ID: '',
    ...overrides,
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}
const busRequest = (extra = {}) =>
  new Request(
    `https://app.example/api/buses?${new URLSearchParams({
      route: '707',
      nodeId: 'outbound',
      cityCode: '25',
      routeId,
      ...extra,
    })}`,
  );
const routeRequest = () =>
  new Request(
    `https://app.example/api/routes?${new URLSearchParams({
      originName: '대전역',
      originLat: '36.33254',
      originLng: '127.43435',
      destinationName: '대전시청',
      destinationLat: '36.350384',
      destinationLng: '127.384633',
    })}`,
  );
const kakaoResponse = () =>
  Response.json({
    status: 'OK',
    routes: [
      {
        properties: { type: 'BUS', totalTime: 1200, transfers: 0 },
        steps: [
          {
            properties: {
              type: 'BUS',
              vehicles: [{ name: '707' }],
              stops: segment.stopNames.map((name) => ({ name })),
            },
            path: { points: [segment.boardingPoint, segment.alightingPoint] },
          },
        ],
      },
    ],
  });

test('ordered route chooses correct direction, not the closer opposite platform', async () => {
  const match = await findTagoRouteMatch(mockClient(), segment);
  assert.deepEqual(match, {
    boardingStop: {
      id: 'outbound',
      name: '대전역',
      cityCode: '25',
      number: '01240',
      latitude: 36.33254,
      longitude: 127.43213,
    },
    routeId,
    nextStopName: '한밭중네거리',
  });
});

test('missing public stop numbers never fall back to internal ID or route order', () => {
  for (const nodeno of [undefined, null, '', '0', 'DJB8001418']) {
    const match = matchOrderedRoute(
      segment,
      '25',
      routeId,
      outbound.map((item) => ({ ...item, nodeno })),
    );
    assert.equal(match.boardingStop.number, undefined);
    assert.equal(match.nextStopName, '한밭중네거리');
  }
});

test('reverse journey and per-direction restarted stop numbers are supported', () => {
  const reversed = {
    ...segment,
    stopNames: [...segment.stopNames].reverse(),
    boardingPoint: segment.alightingPoint,
    alightingPoint: segment.boardingPoint,
  };
  const resetInbound = inbound.map((item, i) => ({ ...item, nodeord: i + 1 }));
  assert.equal(
    matchOrderedRoute(reversed, '25', routeId, [...outbound, ...resetInbound])
      .boardingStop.id,
    'cityhall-in',
  );
});

test('normalizes punctuation but preserves meaningful stop qualifiers', () => {
  const names = [...segment.stopNames];
  names[2] = '시청 · 교육청';
  assert.ok(
    matchOrderedRoute(
      { ...segment, stopNames: names },
      '25',
      routeId,
      outbound,
    ),
  );
  names[0] = '대전역동광장';
  assert.equal(
    matchOrderedRoute(
      { ...segment, stopNames: names },
      '25',
      routeId,
      outbound,
    ),
    null,
  );
});

test('rejects incomplete, malformed, reversed or conflicting stop sequences', () => {
  const invalid = [
    outbound.slice(0, 2),
    outbound.map((s, i) => ({ ...s, nodeord: 3 - i })),
    outbound.map((s, i) => ({ ...s, nodeord: i === 1 ? 10 : s.nodeord })),
    outbound.map((s, i) => ({ ...s, updowncd: i === 2 ? 1 : 0 })),
    outbound.map((s, i) => ({ ...s, gpslati: i === 0 ? '' : s.gpslati })),
    outbound.map((s) => ({ ...s, gpslong: 130 })),
    outbound.map((s) => ({ ...s, routeid: 'wrong-route' })),
    [...outbound, outbound[0]],
  ];
  for (const stops of invalid)
    assert.equal(matchOrderedRoute(segment, '25', routeId, stops), null);
});

test('requires destination coordinates and at least two stops', () => {
  assert.equal(
    matchOrderedRoute(
      { ...segment, alightingPoint: [127, 36] },
      '25',
      routeId,
      outbound,
    ),
    null,
  );
  assert.equal(
    matchOrderedRoute(
      { ...segment, stopNames: ['대전역'] },
      '25',
      routeId,
      outbound,
    ),
    null,
  );
});

test('two matching branches or same-number routes in multiple cities are not guessed', async () => {
  const duplicate = outbound.map((s) => ({
    ...s,
    updowncd: 1,
    nodeid: `branch-${s.nodeid}`,
  }));
  assert.equal(
    matchOrderedRoute(segment, '25', routeId, [...outbound, ...duplicate]),
    null,
  );
  const client = mockClient();
  const list = client.list.bind(client);
  client.list = async (op, params) =>
    op === 'routes' ? [route] : list(op, params);
  assert.equal(await findTagoRouteMatch(client, segment), null);
});

test('missing API permission or too many city candidates fails closed', async () => {
  assert.equal(
    await findTagoRouteMatch(
      {
        list: async () => {
          throw new Error('Not approved');
        },
      },
      segment,
    ),
    null,
  );
  assert.equal(
    await findTagoRouteMatch(
      mockClient({
        nearby: Array.from({ length: 9 }, (_, i) => ({
          ...nearby[0],
          citycode: i + 1,
        })),
      }),
      segment,
    ),
    null,
  );
});

test('a repeated boarding platform is unsafe even when its onward segment is unique', () => {
  const revisited = [...outbound, { ...inbound[2], nodeid: 'outbound' }];
  assert.equal(matchOrderedRoute(segment, '25', routeId, revisited), null);
});

test('an ambiguous matching route is not discarded in favor of a different matching route', async () => {
  const client = {
    async list(operation, params) {
      if (operation === 'nearby')
        return nearby.filter((item) => item.citycode === 25);
      if (operation === 'routes')
        return [route, { ...route, routeid: 'second-route' }];
      if (operation === 'routeStops')
        return params.routeId === routeId
          ? [
              ...outbound,
              ...outbound.map((s) => ({
                ...s,
                updowncd: 1,
                nodeid: `branch-${s.nodeid}`,
              })),
            ]
          : outbound.map((s) => ({ ...s, routeid: 'second-route' }));
    },
  };
  assert.equal(await findTagoRouteMatch(client, segment), null);
});

test('TAGO client handles singleton items, pagination and request-scoped deduplication', async () => {
  const requests = [];
  const client = createTagoClient({
    apiKey: 'key+/=',
    fetcher: async (url, init) => {
      requests.push(url);
      assert.equal(init.cache, 'no-store');
      assert.equal(url.searchParams.get('serviceKey'), 'key+/=');
      const page = Number(url.searchParams.get('pageNo'));
      return tagoResponse(
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ nodeord: i + 1 }))
          : [{ nodeord: 101 }],
        101,
      );
    },
  });
  const [a, b] = await Promise.all([
    client.list('routeStops', { cityCode: '25', routeId }),
    client.list('routeStops', { routeId, cityCode: '25' }),
  ]);
  assert.equal(a.length, 101);
  assert.equal(a, b);
  assert.equal(requests.length, 2);
});

test('TAGO rejects HTTP-200 service errors, truncated or oversized results', async () => {
  const invalid = [
    () => Response.json({ response: { header: { resultCode: '30' } } }),
    () => tagoResponse([], 1),
    () => tagoResponse([], 1001),
    () =>
      Response.json({
        response: { header: { resultCode: '00' }, body: { items: {} } },
      }),
    () =>
      Response.json({
        response: {
          header: { resultCode: '00' },
          body: { totalCount: 1, items: { item: 'broken' } },
        },
      }),
    () => new Response('upstream unavailable', { status: 503 }),
  ];
  for (const fetcher of invalid) {
    await assert.rejects(
      createTagoClient({ apiKey: 'test', fetcher }).list('routes', {
        cityCode: '25',
      }),
    );
  }
});

test('TAGO limits concurrency and respects an already cancelled request', async () => {
  let active = 0,
    peak = 0;
  const client = createTagoClient({
    apiKey: 'test',
    fetcher: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return tagoResponse([]);
    },
  });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      client.list('routes', { cityCode: String(i) }),
    ),
  );
  assert.ok(peak <= 4);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createTagoClient({
      apiKey: 'test',
      signal: controller.signal,
      fetcher: async () => assert.fail('must not send cancelled request'),
    }).list('routes', {}),
  );
});

test('route API carries verified city, stop and route ID through to arrivals', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.hostname === 'dapi.kakao.com') return kakaoResponse();
    if (url.pathname.endsWith('getCrdntPrxmtSttnList'))
      return tagoResponse(nearby);
    if (url.pathname.endsWith('getRouteNoList'))
      return tagoResponse(
        url.searchParams.get('cityCode') === '25' ? [route] : [],
      );
    if (url.pathname.endsWith('getRouteAcctoThrghSttnList'))
      return tagoResponse([...inbound, ...outbound]);
    throw new Error('Unexpected URL');
  });
  const result = await (await getRoutes(routeRequest())).json();
  assert.equal(result.mode, 'live');
  assert.equal(result.trip.arrivalLookupAvailable, true);
  assert.equal(result.trip.routeId, routeId);
  assert.deepEqual(result.trip.boardingStop, {
    id: 'outbound',
    name: '대전역',
    cityCode: '25',
    number: '01240',
    latitude: 36.33254,
    longitude: 127.43213,
  });
  assert.equal(result.trip.nextStopName, '한밭중네거리');
});

test('route API retains real route but never invents an arrival link on permission failure', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.hostname === 'dapi.kakao.com'
      ? kakaoResponse()
      : Response.json({ response: { header: { resultCode: '30' } } }),
  );
  const result = await (await getRoutes(routeRequest())).json();
  assert.equal(result.mode, 'live');
  assert.equal(result.trip.arrivalLookupAvailable, false);
  assert.equal(result.trip.routeId, undefined);
  assert.match(result.trip.boardingStop.id, /^kakao:/);
  assert.equal(result.trip.boardingStop.number, undefined);
  assert.equal(result.trip.nextStopName, undefined);
  assert.equal(result.trip.boardingStop.longitude, segment.boardingPoint[0]);
  assert.equal(result.trip.boardingStop.latitude, segment.boardingPoint[1]);
});

test('bus API filters same-number different routes and rejects absent ETA or wrong stops', async (t) => {
  configure(t);
  const valid = {
    routeno: 707,
    routeid: routeId,
    arrtime: 600,
    arrprevstationcnt: 3,
    vehicletp: '저상버스',
  };
  t.mock.method(globalThis, 'fetch', async () =>
    tagoResponse([
      { ...valid, routeid: 'other-route' },
      { ...valid, arrtime: '' },
      { ...valid, arrtime: null },
      { ...valid, nodeid: 'inbound' },
      valid,
    ]),
  );
  const result = await (await getBuses(busRequest())).json();
  assert.equal(result.mode, 'live');
  assert.equal(result.buses.length, 1);
  assert.equal(result.buses[0].etaSeconds, 600);
  assert.equal(result.buses[0].lowFloor, true);
});

test('bus API only returns confirmed low-floor vehicles from mixed arrivals', async (t) => {
  configure(t);
  const vehicleTypes = [
    '일반버스',
    '저상버스',
    '비저상버스',
    '저상버스 아님',
    '저상 여부 미확인',
    '',
    null,
    undefined,
    1,
    '  저상 버스  ',
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    tagoResponse(
      vehicleTypes.map((vehicletp, index) => ({
        routeno: 707,
        routeid: routeId,
        arrtime: (index + 1) * 60,
        vehicletp,
      })),
    ),
  );
  const result = await (await getBuses(busRequest())).json();
  assert.equal(result.mode, 'live');
  assert.deepEqual(
    result.buses.map((bus) => bus.etaSeconds),
    [120, 600],
  );
  assert.ok(result.buses.every((bus) => bus.lowFloor === true));
});

test('bus API returns no recommendation data when only general or unknown vehicles arrive', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () =>
    tagoResponse(
      ['일반버스', '비저상버스', undefined].map((vehicletp) => ({
        routeno: 707,
        routeid: routeId,
        arrtime: 600,
        vehicletp,
      })),
    ),
  );
  const result = await (await getBuses(busRequest())).json();
  assert.equal(result.mode, 'unavailable');
  assert.deepEqual(result.buses, []);
  assert.match(result.notice, /저상버스 도착정보가 없습니다/);
});

test('demo arrival API also returns only low-floor vehicles without querying TAGO', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Demo arrivals must not query TAGO'),
  );
  for (const params of [{ demo: '1' }, { nodeId: 'demo-stop' }]) {
    const result = await (await getBuses(busRequest(params))).json();
    assert.equal(result.mode, 'demo');
    assert.equal(result.buses.length, 3);
    assert.ok(result.buses.every((bus) => bus.lowFloor === true));
  }
});

test('bus API finds low-floor vehicles after a general-only page and supports zero-second arrivals', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async (url) =>
    tagoResponse(
      url.searchParams.get('pageNo') === '1'
        ? Array.from({ length: 100 }, () => ({
            routeno: 707,
            routeid: routeId,
            arrtime: 300,
            vehicletp: '일반버스',
          }))
        : [
            {
              routeno: 707,
              routeid: routeId,
              arrtime: 0,
              vehicletp: '저상버스',
            },
          ],
      101,
    ),
  );
  const result = await (await getBuses(busRequest())).json();
  assert.equal(result.mode, 'live');
  assert.equal(result.buses.length, 1);
  assert.equal(result.buses[0].etaSeconds, 0);
});

test('unverified Kakao stop IDs never reach TAGO and failures never become demo data', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Unverified stop must not be queried'),
  );
  const result = await (
    await getBuses(busRequest({ nodeId: 'kakao:대전역:36:127' }))
  ).json();
  assert.equal(result.mode, 'unavailable');
  assert.deepEqual(result.buses, []);
});

test('bus API returns unavailable on authorization errors and empty arrivals', async (t) => {
  configure(t);
  let permissionError = true;
  t.mock.method(globalThis, 'fetch', async () =>
    permissionError
      ? Response.json({ response: { header: { resultCode: '30' } } })
      : tagoResponse([]),
  );
  for (const value of [true, false]) {
    permissionError = value;
    const result = await (await getBuses(busRequest())).json();
    assert.equal(result.mode, 'unavailable');
    assert.deepEqual(result.buses, []);
  }
});
