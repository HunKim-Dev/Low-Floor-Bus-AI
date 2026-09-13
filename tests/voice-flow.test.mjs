import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRouteFollowUp,
  parseSpokenRouteQueries,
  uniquePlaceMatch,
  placeSearchFailure,
} from '../lib/voice-route.ts';
import {
  searchPlacesForQuery,
  normalizeSearchPlace,
} from '../lib/place-search.ts';
import { interpretVoice, validateVoiceIntent } from '../lib/voice-intent.ts';
import {
  mergeVoiceDraft,
  resolveVoiceDraft,
  candidateFromSpeech,
} from '../lib/voice-journey.ts';
import { demoPlaces } from '../lib/trip-planning.ts';

const seoul = demoPlaces.find((place) => place.name === '서울역');
const gangnam = demoPlaces.find((place) => place.name === '강남역');
const response = (body, status = 200) =>
  Promise.resolve(Response.json(body, { status }));

test('spoken labels and polite endings are cleaned without losing station names', () => {
  for (const message of [
    '출발 서울역 도착 강남역',
    '출발 지는 서울역이고요 도착 지는 강남역입니다',
    '서울역에서 출발해서 강남역으로 가고 싶어',
  ]) {
    assert.deepEqual(parseSpokenRouteQueries(message), {
      originQuery: '서울역',
      destinationQuery: '강남역',
    });
  }
});

test('a single follow-up answers the pending slot, explicit routes override it', () => {
  assert.deepEqual(parseRouteFollowUp('서울역', 'origin'), {
    originQuery: '서울역',
    destinationQuery: '',
  });
  assert.deepEqual(parseRouteFollowUp('서울역', 'destination'), {
    originQuery: '',
    destinationQuery: '서울역',
  });
  assert.deepEqual(parseRouteFollowUp('강남역에서 서울역까지', 'origin'), {
    originQuery: '강남역',
    destinationQuery: '서울역',
  });
});

test('place names containing 분 are not mistaken for minute settings', () => {
  assert.equal(
    parseRouteFollowUp('분당서울대학교병원', 'origin').originQuery,
    '분당서울대학교병원',
  );
  assert.deepEqual(
    parseSpokenRouteQueries('출발지는 서울역이야 그리고 도착지는 강남역'),
    { originQuery: '서울역', destinationQuery: '강남역' },
  );
});

test('a partial result must be confirmed even when it is the only result', () => {
  assert.equal(uniquePlaceMatch('서울역', [{ name: '서울역 카페' }]), null);
  assert.equal(uniquePlaceMatch('서울 역', [seoul]), seoul);
});

test('demo search accepts speech spacing and declares missing configuration', async () => {
  const result = await searchPlacesForQuery('서 울 역', {
    fetcher: () => {
      throw new Error('must not fetch');
    },
  });
  assert.equal(result.reason, 'not_configured');
  assert.equal(result.places[0].name, '서울역');
  assert.equal((await searchPlacesForQuery('잠실역')).places.length, 0);
  assert.match(
    placeSearchFailure('demo', '잠실역', 'origin'),
    /실제 장소 검색이 아직 연결/,
  );
});

test('live search retries spacing then address lookup, never demo on error', async () => {
  const urls = [];
  const result = await searchPlacesForQuery('서울 역', {
    apiKey: 'test-key',
    fetcher: (url) => {
      urls.push(new URL(url));
      return response({
        documents:
          urls.length === 2
            ? [{ id: 'a', place_name: '서울역', x: '126.97', y: '37.55' }]
            : [],
      });
    },
  });
  assert.equal(result.mode, 'live');
  assert.deepEqual(
    urls.map((url) => url.searchParams.get('query')),
    ['서울 역', '서울역'],
  );
  const address = await searchPlacesForQuery('서울 용산구 한강대로 405', {
    apiKey: 'test-key',
    fetcher: (url) =>
      response({
        documents: new URL(url).pathname.includes('/address.')
          ? [
              {
                address_name: '서울 용산구 한강대로 405',
                x: '126.97',
                y: '37.55',
              },
            ]
          : [],
      }),
  });
  assert.equal(address.places[0].name, '서울 용산구 한강대로 405');
  const failure = await searchPlacesForQuery('서울역', {
    apiKey: 'test-key',
    fetcher: () => response({}, 401),
  });
  assert.equal(failure.mode, 'unavailable');
  assert.deepEqual(failure.places, []);
});

test('invalid upstream coordinates are never treated as real places', () => {
  for (const coordinates of [
    { x: null, y: null },
    { x: '', y: '' },
    { x: '181', y: '37' },
    { x: 'NaN', y: '37' },
  ]) {
    assert.equal(
      normalizeSearchPlace({ id: 'a', place_name: '장소', ...coordinates }),
      null,
    );
  }
});

test('choosing an ambiguous origin preserves and resolves the spoken destination', async () => {
  const branches = [
    { ...seoul, id: 'a', name: '중앙병원' },
    { ...gangnam, id: 'b', name: '중앙병원' },
  ];
  const first = await resolveVoiceDraft(
    mergeVoiceDraft(
      null,
      { originQuery: '중앙병원', destinationQuery: '강남역' },
      null,
      null,
    ),
    {
      search: async () => ({ mode: 'live', places: branches }),
      locate: async () => seoul,
    },
  );
  assert.equal(first.kind, 'choose');
  assert.equal(first.draft.destinationQuery, '강남역');
  const second = await resolveVoiceDraft(
    { ...first.draft, origin: branches[0] },
    {
      search: async (query) => {
        assert.equal(query, '강남역');
        return { mode: 'live', places: [gangnam] };
      },
      locate: async () => seoul,
    },
  );
  assert.equal(second.kind, 'complete');
  assert.equal(second.origin.id, 'a');
  assert.equal(second.destination.id, gangnam.id);
});

test('a failed destination keeps the confirmed origin for the next utterance', async () => {
  const first = await resolveVoiceDraft(
    mergeVoiceDraft(
      null,
      { originQuery: '서울역', destinationQuery: '잠실역' },
      null,
      null,
    ),
    {
      search: async (query) => ({
        mode: 'demo',
        places: query === '서울역' ? [seoul] : [],
      }),
      locate: async () => seoul,
    },
  );
  assert.equal(first.kind, 'retry');
  assert.equal(first.draft.origin.id, seoul.id);
  const followUp = mergeVoiceDraft(
    first.draft,
    parseRouteFollowUp('강남역', first.slot),
    null,
    null,
  );
  const result = await resolveVoiceDraft(followUp, {
    search: async () => ({ mode: 'live', places: [gangnam] }),
    locate: async () => seoul,
  });
  assert.equal(result.kind, 'complete');
  assert.equal(result.origin.id, seoul.id);
});

test('missing origin asks only for origin and retains destination query', async () => {
  const result = await resolveVoiceDraft(
    mergeVoiceDraft(
      null,
      { originQuery: '', destinationQuery: '강남역' },
      null,
      null,
    ),
    {
      search: async () => {
        throw new Error('must not search yet');
      },
      locate: async () => seoul,
    },
  );
  assert.equal(result.kind, 'retry');
  assert.equal(result.slot, 'origin');
  assert.equal(result.draft.destinationQuery, '강남역');
});

test('unresolved home, GPS failure and same endpoints ask rather than guess', async () => {
  for (const query of ['집', '현재 위치']) {
    const result = await resolveVoiceDraft(
      mergeVoiceDraft(
        null,
        { originQuery: query, destinationQuery: '강남역' },
        null,
        null,
      ),
      {
        search: async () => {
          throw new Error('must not search');
        },
        locate: async () => {
          throw new Error('denied');
        },
      },
    );
    assert.equal(result.kind, 'retry');
    assert.equal(result.slot, 'origin');
  }
  const same = await resolveVoiceDraft(
    mergeVoiceDraft(
      null,
      { originQuery: '', destinationQuery: '' },
      seoul,
      seoul,
    ),
    {
      search: async () => ({ mode: 'live', places: [] }),
      locate: async () => seoul,
    },
  );
  assert.equal(same.kind, 'retry');
  assert.equal(same.slot, 'destination');
});

test('numbered voice selection cannot select outside the shown list', () => {
  for (const message of ['2번', '두 번째', '두 번째로 해줘'])
    assert.equal(candidateFromSpeech(message, [seoul, gangnam]).id, gangnam.id);
  assert.equal(candidateFromSpeech('9번', [seoul, gangnam]), null);
  assert.equal(candidateFromSpeech('2번 버스', [seoul, gangnam]), null);
});

test('AI disabled uses honest local mode without network', async () => {
  const result = await interpretVoice('서울역', 'origin', {
    fetcher: () => {
      throw new Error('unexpected request');
    },
  });
  assert.equal(result.mode, 'local');
  assert.equal(result.reason, 'not_configured');
  assert.equal(result.originQuery, '서울역');
});

test('AI integration constrains schema and sends no coordinates or audio', async () => {
  const intent = {
    originQuery: '서울역',
    destinationQuery: '강남역',
    clarification: null,
  };
  const result = await interpretVoice('서울역에서 강남역까지', null, {
    apiKey: 'test-key',
    fetcher: (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      assert.deepEqual(Object.keys(JSON.parse(body.input)).sort(), [
        'message',
        'pendingSlot',
      ]);
      return response({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(intent) }],
          },
        ],
      });
    },
  });
  assert.equal(result.mode, 'model');
  assert.equal(result.destinationQuery, '강남역');
});

test('model errors, refusals and fabricated extra fields fall back to local extraction', async () => {
  for (const body of [
    { status: 'incomplete', output: [] },
    {
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] },
      ],
    },
    {
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                originQuery: '서울역',
                destinationQuery: '강남역',
                clarification: null,
                latitude: 37,
              }),
            },
          ],
        },
      ],
    },
  ]) {
    const result = await interpretVoice('서울역에서 강남역까지', null, {
      apiKey: 'test-key',
      fetcher: () => response(body),
    });
    assert.equal(result.mode, 'local');
    assert.equal(result.reason, 'model_unavailable');
  }
  assert.throws(() =>
    validateVoiceIntent({
      originQuery: 123,
      destinationQuery: '',
      clarification: null,
    }),
  );
});
