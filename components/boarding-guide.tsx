import { ChevronDown, ExternalLink, MapPin, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  boardingHelpQuestion,
  boardingMapUrl,
  publicStopNumber,
} from '@/lib/boarding-guidance';
import type { TripPlan } from '@/lib/trip-planning';
import type { SpeechState } from '@/lib/speech-player';

export function BoardingGuide({
  trip,
  speechState,
  onSpeak,
  onStop,
}: {
  trip: TripPlan;
  speechState: SpeechState;
  onSpeak: (message: string) => void;
  onStop: () => void;
}) {
  const number = publicStopNumber(trip.boardingStop.number);
  const mapUrl = boardingMapUrl(trip.boardingStop);
  const busy = speechState.phase !== 'idle';
  const demo = trip.id.startsWith('demo:');
  return (
    <section aria-label="타는 정류장 안내" className="py-4">
      <p className="text-sm font-medium text-[#6B7684]">타는 곳</p>
      <h3 className="mt-1 break-words text-xl font-bold text-[#191F28]">
        {trip.boardingStop.name}
      </h3>
      {number && (
        <p className="mt-1 text-base font-semibold tabular-nums text-[#4E5968]">
          정류장 번호 {number}
        </p>
      )}
      <p className="mt-2 break-words text-base font-semibold text-[#2165D6]">
        {trip.direction} · {trip.route}번
      </p>
      {trip.nextStopName && (
        <p className="mt-1 break-words text-sm leading-6 text-[#4E5968]">
          이 버스의 다음 정류장 · {trip.nextStopName}
        </p>
      )}
      <p className="mt-3 break-words text-sm leading-6 text-[#6B7684]">
        {trip.alightingStop.name}에서 내려요
      </p>
      <p className="mt-1 text-sm leading-6 text-[#6B7684]">
        같은 이름이어도 방향이 다를 수 있어요. 타기 전 방향을 확인해 주세요.
      </p>
      {mapUrl && (
        <a
          href={mapUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold text-[#1B64DA] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
        >
          <MapPin aria-hidden="true" className="size-4" />
          지도에서 타는 곳 보기
          <ExternalLink aria-hidden="true" className="size-4" />
          <span className="sr-only">(새 창)</span>
        </a>
      )}
      <details className="mt-2">
        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-semibold text-[#4E5968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]">
          주변에 물어볼 때
          <ChevronDown aria-hidden="true" className="ml-auto size-4" />
        </summary>
        <div className="rounded-xl bg-white p-4">
          {demo && (
            <p className="mb-2 text-sm text-[#6B7684]">
              체험용 문장이에요. 실제 이동에는 쓰지 마세요.
            </p>
          )}
          <p className="break-words text-xl font-semibold leading-relaxed">
            {boardingHelpQuestion(trip)}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4 min-h-12 w-full rounded-xl border-0 bg-[#E8F3FF] font-semibold text-[#1B64DA]"
            onClick={() =>
              busy
                ? onStop()
                : onSpeak(
                    (demo
                      ? '체험용 안내예요. 실제 이동에 사용하지 마세요. '
                      : '') + boardingHelpQuestion(trip, true),
                  )
            }
          >
            <Volume2 aria-hidden="true" className="size-5" />
            {speechState.phase === 'loading'
              ? '음성 준비 취소'
              : busy
                ? '음성 멈추기'
                : '이 문장 읽어주기'}
          </Button>
        </div>
      </details>
    </section>
  );
}
