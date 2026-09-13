import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentLocation,
  locationErrorMessage,
  LocationError,
} from '../lib/current-location.ts';

const position = {
  coords: { latitude: 37.55, longitude: 126.97, accuracy: 25 },
};

test('valid GPS coordinates become a current-location Place without any API key', async () => {
  const place = await getCurrentLocation({
    secureContext: true,
    geolocation: { getCurrentPosition: (success) => success(position) },
  });
  assert.equal(place.name, '현재 위치');
  assert.equal(place.latitude, 37.55);
  assert.match(place.id, /^current-/);
  assert.match(place.address, /25m/);
});

test('unavailable precise GPS retries with normal location once', async () => {
  const attempts = [];
  const place = await getCurrentLocation({
    secureContext: true,
    geolocation: {
      getCurrentPosition: (success, fail, options) => {
        attempts.push(options.enableHighAccuracy);
        if (options.enableHighAccuracy) fail({ code: 2 });
        else success(position);
      },
    },
  });
  assert.deepEqual(attempts, [true, false]);
  assert.equal(place.name, '현재 위치');
});

test('permission denied is not retried or mislabeled as timeout', async () => {
  let calls = 0;
  await assert.rejects(
    getCurrentLocation({
      secureContext: true,
      geolocation: {
        getCurrentPosition: (_success, fail) => {
          calls++;
          fail({ code: 1 });
        },
      },
    }),
    { code: 'permission' },
  );
  assert.equal(calls, 1);
  assert.match(locationErrorMessage(new LocationError('permission')), /차단/);
});

test('two timeouts end with actionable timeout feedback', async () => {
  let calls = 0;
  await assert.rejects(
    getCurrentLocation({
      secureContext: true,
      geolocation: {
        getCurrentPosition: (_success, fail) => {
          calls++;
          fail({ code: 3 });
        },
      },
    }),
    { code: 'timeout' },
  );
  assert.equal(calls, 2);
  assert.match(
    locationErrorMessage(new LocationError('timeout')),
    /시간이 오래/,
  );
});

test('closing picker cancels pending GPS and ignores late callbacks', async () => {
  const controller = new AbortController();
  let success;
  const promise = getCurrentLocation({
    secureContext: true,
    signal: controller.signal,
    geolocation: {
      getCurrentPosition: (callback) => {
        success = callback;
      },
    },
  });
  controller.abort();
  success(position);
  await assert.rejects(promise, { code: 'cancelled' });
});

test('unsupported browser and insecure context return distinct errors', async () => {
  await assert.rejects(getCurrentLocation({ secureContext: true }), {
    code: 'unsupported',
  });
  await assert.rejects(getCurrentLocation({ secureContext: false }), {
    code: 'insecure',
  });
});

test('invalid coordinates never become a registered location', async () => {
  await assert.rejects(
    getCurrentLocation({
      secureContext: true,
      geolocation: {
        getCurrentPosition: (success) =>
          success({ coords: { latitude: NaN, longitude: 127 } }),
      },
    }),
    { code: 'unavailable' },
  );
});
