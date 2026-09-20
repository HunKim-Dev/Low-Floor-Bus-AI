import { tagoText, type TagoClient, type TagoItem } from './tago-client.ts';
import type { TripStop } from './trip-planning.ts';
import { publicStopNumber } from './boarding-guidance.ts';

export type TransitSegment = {
  route: string;
  stopNames: string[];
  boardingPoint: [number, number]; // longitude, latitude
  alightingPoint: [number, number];
};

export type TagoRouteMatch = {
  boardingStop: TripStop;
  routeId: string;
  nextStopName: string;
};

export function normalizeStopName(name: string) {
  return name.normalize('NFKC').replace(/[\s.,·()[\]{}\-_/]/g, '');
}

function normalizeRoute(value: unknown) {
  return tagoText(value).normalize('NFKC').replace(/\s/g, '');
}

function point(item: TagoItem): [number, number] | null {
  if (!tagoText(item.gpslong) || !tagoText(item.gpslati)) return null;
  const longitude = Number(item.gpslong);
  const latitude = Number(item.gpslati);
  return Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    Math.abs(longitude) <= 180 &&
    Math.abs(latitude) <= 90
    ? [longitude, latitude]
    : null;
}

function distance(first: [number, number], second: [number, number]) {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(rad(second[1] - first[1]) / 2) ** 2 +
    Math.cos(rad(first[1])) *
      Math.cos(rad(second[1])) *
      Math.sin(rad(second[0] - first[0]) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

// A name/nearest-coordinate match alone cannot distinguish opposite platforms.
// Require the complete ordered segment, on one direction, and both endpoint coordinates.
function orderedRouteMatches(
  segment: TransitSegment,
  cityCode: string,
  routeId: string,
  items: TagoItem[],
): TagoRouteMatch[] | null {
  const names = segment.stopNames.map(normalizeStopName);
  if (names.length < 2 || names.some((name) => !name)) return [];
  const directions = new Map<string, TagoItem[]>();
  for (const item of items) {
    const direction = tagoText(item.updowncd);
    const order = Number(item.nodeord);
    if (
      tagoText(item.routeid) !== routeId ||
      !tagoText(item.nodeid) ||
      !tagoText(item.nodenm) ||
      !Number.isInteger(order) ||
      order < 1 ||
      !point(item)
    ) {
      return null;
    }
    const group = directions.get(direction) ?? [];
    group.push(item);
    directions.set(direction, group);
  }
  const matches: TagoRouteMatch[] = [];
  for (const stops of directions.values()) {
    stops.sort((a, b) => Number(a.nodeord) - Number(b.nodeord));
    if (
      new Set(stops.map((stop) => Number(stop.nodeord))).size !== stops.length
    )
      return null;
    for (let start = 0; start <= stops.length - names.length; start++) {
      const slice = stops.slice(start, start + names.length);
      if (
        !slice.every(
          (stop, index) =>
            normalizeStopName(tagoText(stop.nodenm)) === names[index] &&
            (index === 0 ||
              Number(stop.nodeord) === Number(slice[index - 1].nodeord) + 1),
        )
      )
        continue;
      if (
        distance(segment.boardingPoint, point(slice[0])!) > 150 ||
        distance(segment.alightingPoint, point(slice.at(-1)!)!) > 150
      )
        continue;
      const match = {
        boardingStop: {
          id: tagoText(slice[0].nodeid),
          name: segment.stopNames[0],
          cityCode,
          number: publicStopNumber(slice[0].nodeno),
          longitude: point(slice[0])![0],
          latitude: point(slice[0])![1],
        },
        routeId,
        nextStopName: tagoText(slice[1].nodenm),
      };
      matches.push(match);
      // Arrival rows cannot distinguish two visits of the same route to one platform.
      if (
        items.filter((item) => tagoText(item.nodeid) === match.boardingStop.id)
          .length > 1
      ) {
        return null;
      }
    }
  }
  return matches;
}

export function matchOrderedRoute(
  segment: TransitSegment,
  cityCode: string,
  routeId: string,
  items: TagoItem[],
): TagoRouteMatch | null {
  const matches = orderedRouteMatches(segment, cityCode, routeId, items);
  return matches?.length === 1 ? matches[0] : null;
}

export async function findTagoRouteMatch(
  client: TagoClient,
  segment: TransitSegment,
): Promise<TagoRouteMatch | null> {
  try {
    const nearby = await client.list('nearby', {
      gpsLong: String(segment.boardingPoint[0]),
      gpsLati: String(segment.boardingPoint[1]),
    });
    const cities = [
      ...new Set(
        nearby
          .filter((item) => {
            const location = point(item);
            return (
              location &&
              distance(segment.boardingPoint, location) <= 250 &&
              normalizeStopName(tagoText(item.nodenm)) ===
                normalizeStopName(segment.stopNames[0] ?? '')
            );
          })
          .map((item) => tagoText(item.citycode))
          .filter(Boolean),
      ),
    ];
    if (!cities.length || cities.length > 8) return null;

    const routes = (
      await Promise.all(
        cities.map(async (cityCode) => {
          const items = await client.list('routes', {
            cityCode,
            routeNo: segment.route,
          });
          return items
            .filter(
              (item) =>
                normalizeRoute(item.routeno) ===
                  normalizeRoute(segment.route) && tagoText(item.routeid),
            )
            .map((item) => ({ cityCode, routeId: tagoText(item.routeid) }));
        }),
      )
    )
      .flat()
      .filter(
        (route, index, all) =>
          all.findIndex(
            (other) =>
              other.cityCode === route.cityCode &&
              other.routeId === route.routeId,
          ) === index,
      );
    if (!routes.length || routes.length > 12) return null;

    const routeMatches = await Promise.all(
      routes.map(async ({ cityCode, routeId }) => {
        const stops = await client.list('routeStops', { cityCode, routeId });
        return orderedRouteMatches(segment, cityCode, routeId, stops);
      }),
    );
    if (routeMatches.some((matches) => matches === null)) return null;
    const matches = routeMatches.flatMap((matches) => matches ?? []);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    // Missing permission, incomplete data, or ambiguity must never create a guessed stop.
    return null;
  }
}
