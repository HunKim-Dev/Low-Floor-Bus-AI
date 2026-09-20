const operations = {
  nearby: 'BusSttnInfoInqireService/getCrdntPrxmtSttnList',
  routes: 'BusRouteInfoInqireService/getRouteNoList',
  routeStops: 'BusRouteInfoInqireService/getRouteAcctoThrghSttnList',
  arrivals: 'ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',
} as const;

export type TagoItem = Record<string, unknown>;
type Operation = keyof typeof operations;
export type TagoClient = {
  list: (
    operation: Operation,
    params: Record<string, string>,
  ) => Promise<TagoItem[]>;
};

export function tagoText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

// Request-scoped memoization: alternatives share lookups, but arrival data is never cached.
export function createTagoClient(options: {
  apiKey: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): TagoClient {
  const fetcher = options.fetcher ?? fetch;
  const deadline = options.signal ?? AbortSignal.timeout(15_000);
  const pending = new Map<string, Promise<TagoItem[]>>();
  let active = 0;
  const queue: (() => void)[] = [];

  async function page(
    operation: Operation,
    params: Record<string, string>,
    pageNo: number,
  ) {
    if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      deadline.throwIfAborted();
      const url = new URL(
        `https://apis.data.go.kr/1613000/${operations[operation]}`,
      );
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
      url.searchParams.set('serviceKey', options.apiKey);
      url.searchParams.set('_type', 'json');
      url.searchParams.set('numOfRows', '100');
      url.searchParams.set('pageNo', String(pageNo));
      const response = await fetcher(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) throw new Error('TAGO request failed');
      const payload = await response.json();
      // TAGO also returns authorization/quota errors with HTTP 200.
      if (tagoText(payload?.response?.header?.resultCode) !== '00') {
        throw new Error('TAGO service rejected the request');
      }
      const body = payload?.response?.body;
      const total = Number(body?.totalCount);
      if (
        !body ||
        tagoText(body.totalCount) === '' ||
        !Number.isInteger(total) ||
        total < 0 ||
        total > 1_000
      ) {
        throw new Error('TAGO result is incomplete');
      }
      const value = body.items?.item;
      const items =
        value == null || value === ''
          ? []
          : Array.isArray(value)
            ? value
            : [value];
      if (
        items.some(
          (item: unknown) =>
            !item || typeof item !== 'object' || Array.isArray(item),
        )
      ) {
        throw new Error('TAGO result is invalid');
      }
      return { items: items as TagoItem[], total };
    } finally {
      active--;
      queue.shift()?.();
    }
  }

  async function allPages(
    operation: Operation,
    params: Record<string, string>,
  ) {
    const items: TagoItem[] = [];
    let expectedTotal: number | undefined;
    for (let pageNo = 1; pageNo <= 10; pageNo++) {
      const result = await page(operation, params, pageNo);
      if (expectedTotal !== undefined && expectedTotal !== result.total) {
        throw new Error('TAGO result changed during pagination');
      }
      expectedTotal = result.total;
      items.push(...result.items);
      if (items.length === expectedTotal) return items;
      if (!result.items.length || items.length > expectedTotal) break;
    }
    throw new Error('TAGO result is incomplete');
  }

  return {
    list(operation, params) {
      const key = JSON.stringify([
        operation,
        Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      let result = pending.get(key);
      if (!result) {
        result = allPages(operation, params);
        pending.set(key, result);
      }
      return result;
    },
  };
}
