'use client';

import {
  ArrowDown,
  BellRing,
  BusFront,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  History,
  LoaderCircle,
  LocateFixed,
  MapPin,
  Mic,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Volume2,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { TransitStop } from '@/lib/demo-stops';
import { parseRouteFollowUp, placeSearchFailure } from '@/lib/voice-route';
import {
  mergeVoiceDraft,
  resolveVoiceDraft,
  candidateFromSpeech,
  type VoiceDraft,
} from '@/lib/voice-journey';
import type { PlaceSearchResult } from '@/lib/place-search';
import type { VoiceIntent } from '@/lib/voice-intent';
import {
  getCurrentLocation,
  locationErrorMessage,
} from '@/lib/current-location';
import {
  defaultSettings,
  restoreSettings,
  stampArrivals,
  remainingBus,
  getRecommendation,
  createAlertPlan,
  dueAlert,
  timingKey,
  travelMinutesForRoute,
  type Settings,
  type BusCandidate,
  type AlertPlan,
} from '@/lib/journey';
import {
  createDemoTrip,
  demoPlaces,
  type Place,
  type TripPlan,
} from '@/lib/trip-planning';

type RecognitionEventLike = {
  results: ArrayLike<{
    0: { transcript: string };
    isFinal?: boolean;
  }>;
};

type RecognitionErrorEventLike = {
  error?: string;
};

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => RecognitionLike;

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type AgentTraceStep = {
  label: string;
  detail: string;
  status: 'complete' | 'attention' | 'waiting';
};

type AssistantResponse = {
  mode: 'local-agent' | 'model';
  intent: 'clarify_stop' | 'clarify_destination' | 'recommend_accessible_bus';
  changes: {
    stopId?: string;
    originPlaceId?: string;
    destinationPlaceId?: string;
    preparationMinutes?: number;
    travelMinutes?: number;
    safetyMinutes?: number;
  };
  responseText: string;
  needsClarification: boolean;
  trace: AgentTraceStep[];
};

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (
    input: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

type ModelContext = {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }

  interface Document {
    modelContext?: ModelContext;
  }
}

const initialDemoTrip = createDemoTrip(demoPlaces[0], demoPlaces[1]);

function getVoiceQualityScore(voice: SpeechSynthesisVoice) {
  const name = voice.name.toLowerCase();
  let score = voice.default ? 2 : 0;
  if (voice.localService) score += 1;
  if (/premium|enhanced|natural|neural/.test(name)) score += 12;
  if (/yuna|유나|sora|소라/.test(name)) score += 8;
  if (/google/.test(name)) score += 6;
  return score;
}

function formatClock(minutesFromNow: number, baseTime: number | null) {
  if (baseTime === null) return '계산 중';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(baseTime + Math.max(0, minutesFromNow) * 60_000));
}

function readRecognitionTranscript(event: RecognitionEventLike) {
  const parts: string[] = [];
  for (let index = 0; index < event.results.length; index += 1) {
    const transcript = event.results[index]?.[0]?.transcript?.trim();
    if (transcript) parts.push(transcript);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function requestPlaceMatches(
  query: string,
  center: Place | null,
  signal?: AbortSignal,
): Promise<PlaceSearchResult> {
  const requestUrl = new URL('/api/places', window.location.origin);
  requestUrl.searchParams.set('query', query);
  if (center && center.id !== 'unset') {
    requestUrl.searchParams.set('lat', String(center.latitude));
    requestUrl.searchParams.set('lng', String(center.longitude));
  }
  try {
    const response = await fetch(requestUrl, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(11_000)])
        : AbortSignal.timeout(11_000),
    });
    if (!response.ok)
      return { mode: 'unavailable', places: [], reason: 'service_error' };
    return (await response.json()) as PlaceSearchResult;
  } catch {
    if (signal?.aborted) throw new Error('request cancelled');
    return { mode: 'unavailable', places: [], reason: 'service_error' };
  }
}

function requestCurrentLocation(signal?: AbortSignal) {
  return getCurrentLocation({
    geolocation: navigator.geolocation,
    secureContext: window.isSecureContext,
    signal,
  });
}

function isSamePlace(first: Place, second: Place) {
  if (first.id === second.id) return true;
  return (
    Math.abs(first.latitude - second.latitude) < 0.00001 &&
    Math.abs(first.longitude - second.longitude) < 0.00001
  );
}

export default function BusApp() {
  const [origin, setOrigin] = useState<Place>({
    ...demoPlaces[0],
    id: 'unset',
    name: '출발지 선택',
  });
  const [destination, setDestination] = useState<Place | null>(null);
  const [trip, setTrip] = useState<TripPlan | null>(null);
  const [alternativeTrips, setAlternativeTrips] = useState<TripPlan[]>([]);
  const [tripMode, setTripMode] = useState<'demo' | 'live' | 'unavailable'>(
    'demo',
  );
  const [tripBusy, setTripBusy] = useState(false);
  const [tripError, setTripError] = useState<string | null>(null);
  const [selectedStop, setSelectedStop] = useState<TransitStop>(() => ({
    id: initialDemoTrip.boardingStop.id,
    name: initialDemoTrip.boardingStop.name,
    direction: initialDemoTrip.direction,
    route: initialDemoTrip.route,
    cityCode: initialDemoTrip.boardingStop.cityCode,
  }));
  const [placePicker, setPlacePicker] = useState<
    'origin' | 'destination' | null
  >(null);
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<Place[]>([]);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeMessage, setPlaceMessage] = useState(
    '장소 이름이나 주소를 검색해 주세요.',
  );
  const [buses, setBuses] = useState<BusCandidate[]>([]);
  const [busesBusy, setBusesBusy] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [dataMode, setDataMode] = useState<'demo' | 'live' | 'unavailable'>(
    'demo',
  );
  const [alertPlan, setAlertPlan] = useState<AlertPlan | null>(null);
  const tracking = alertPlan !== null;
  const setTracking = (active: boolean) => {
    if (!active) setAlertPlan(null);
  };
  const sentAlerts = useRef({ prepare: false, depart: false });
  const [alertPhase, setAlertPhase] = useState<
    'waiting' | 'prepare' | 'depart'
  >('waiting');
  const [notice, setNotice] = useState<string | null>(null);
  const [tapToTalk, setTapToTalk] = useState(false);
  const [listening, setListening] = useState(false);
  const [statusMessage, setStatusMessage] = useState('도착지를 선택해 주세요.');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(
    null,
  );
  const [feedbackComplete, setFeedbackComplete] = useState(false);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [editingVoiceText, setEditingVoiceText] = useState(false);
  const [voiceModeNotice, setVoiceModeNotice] = useState('');
  const [voiceChoiceActive, setVoiceChoiceActive] = useState(false);
  const voiceDraftRef = useRef<VoiceDraft | null>(null);
  const voiceCandidatesRef = useRef<Place[]>([]);
  const assistantRequestRef = useRef<AbortController | null>(null);
  const locationRequestRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const voiceSessionIdRef = useRef(0);
  const voicePressActiveRef = useRef(false);
  const voicePointerIdRef = useRef<number | null>(null);
  const voiceKeyboardActiveRef = useRef(false);
  const voiceClickSuppressedRef = useRef(false);
  const voiceSubmittingRef = useRef(false);
  const voiceTranscriptRef = useRef('');
  const finishVoiceSessionRef = useRef<(() => void) | null>(null);
  const voiceLimitTimerRef = useRef<number | null>(null);
  const voiceRestartTimerRef = useRef<number | null>(null);
  const voiceFinalTimerRef = useRef<number | null>(null);
  const assistantCloseTimerRef = useRef<number | null>(null);
  const [assistantReply, setAssistantReply] = useState(
    '바꾸고 싶은 내용을 말해 주세요.',
  );
  const [availableVoices, setAvailableVoices] = useState<
    SpeechSynthesisVoice[]
  >([]);
  const koreanVoiceOptions = useMemo(
    () =>
      availableVoices
        .filter((voice) => voice.lang.toLowerCase().startsWith('ko'))
        .sort((a, b) => getVoiceQualityScore(b) - getVoiceQualityScore(a)),
    [availableVoices],
  );

  const travelMinutes = travelMinutesForRoute(
    settings,
    trip?.walkToStopMinutes,
  );
  const effectiveSettings = useMemo(
    () => ({ ...settings, travelMinutes }),
    [settings, travelMinutes],
  );
  const result = useMemo(
    () => getRecommendation(buses, effectiveSettings, clockNow ?? 0),
    [buses, effectiveSettings, clockNow],
  );
  const feedStale =
    dataMode === 'live' &&
    lastUpdatedAt !== null &&
    (clockNow ?? 0) - lastUpdatedAt > 90_000;
  const recommended = feedStale
    ? null
    : alertPlan
      ? remainingBus(alertPlan.bus, clockNow ?? 0)
      : result.recommended;
  const excluded = result.excluded;
  const requiredLead = result.requiredLead;
  const prepOffset = alertPlan
    ? (alertPlan.prepareAt - (clockNow ?? 0)) / 60_000
    : recommended
      ? recommended.etaMinutes - requiredLead
      : null;
  const departureOffset = recommended
    ? recommended.etaMinutes - travelMinutes - settings.safetyMinutes
    : null;

  const displayMode = feedStale
    ? 'unavailable'
    : tripMode === 'live' && dataMode === 'live'
      ? 'live'
      : tripMode === 'demo' && dataMode === 'demo'
        ? 'demo'
        : tripMode === 'unavailable' || dataMode === 'unavailable'
          ? 'unavailable'
          : 'checking';

  const recommendationText =
    recommended && trip && destination
      ? `${displayMode === 'demo' ? '체험용 안내입니다. ' : ''}${Math.max(0, Math.ceil(departureOffset ?? 0))}분 뒤 출발하세요. ${trip.boardingStop.name}에서 ${trip.direction} ${recommended.route}번 저상버스를 타세요.`
      : '현재 준비시간과 이동시간으로 여유 있게 탈 수 있는 저상버스를 찾지 못했어요.';

  const announce = useCallback(
    (message: string, automatic = false) => {
      if ((automatic && !settings.voiceAlerts) || typeof window === 'undefined')
        return;
      if (!('speechSynthesis' in window)) {
        setStatusMessage('이 브라우저에서는 음성 출력을 지원하지 않아요.');
        return;
      }
      window.speechSynthesis.cancel();
      const koreanVoices = availableVoices
        .filter((voice) => voice.lang.toLowerCase().startsWith('ko'))
        .sort((a, b) => getVoiceQualityScore(b) - getVoiceQualityScore(a));
      const selectedVoice =
        koreanVoices.find((voice) => voice.voiceURI === settings.voiceURI) ??
        koreanVoices[0];
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.lang = 'ko-KR';
      utterance.voice = selectedVoice ?? null;
      utterance.rate = settings.voiceRate;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onerror = (event) => {
        if (event.error !== 'canceled' && event.error !== 'interrupted')
          setNotice('음성을 재생하지 못했어요. 다시 듣기를 눌러 주세요.');
      };
      window.speechSynthesis.speak(utterance);
    },
    [
      availableVoices,
      settings.voiceAlerts,
      settings.voiceRate,
      settings.voiceURI,
    ],
  );

  const notify = useCallback(
    (title: string, body: string) => {
      announce(title + '. ' + body, true);
      if (settings.vibrationAlerts && 'vibrate' in navigator) {
        navigator.vibrate([180, 90, 180]);
      }
      if ('Notification' in window && Notification.permission === 'granted') {
        void navigator.serviceWorker
          ?.getRegistration()
          .then((registration) => {
            if (registration)
              return registration.showNotification(title, {
                body,
                icon: '/icon.svg',
                tag: 'departure-alert',
              });
          })
          .catch(() =>
            setNotice(
              '기기 알림을 보내지 못했어요. 화면의 안내를 확인해 주세요.',
            ),
          );
      }
      setStatusMessage(title + ' — ' + body);
    },
    [announce, settings.vibrationAlerts],
  );

  const startAlerts = useCallback(async () => {
    if (!recommended || !trip || !destination) {
      setStatusMessage('알림을 시작할 수 있는 저상버스가 아직 없어요.');
      return { started: false, reason: 'no_recommendation' };
    }
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* In-page guidance remains available. */
      }
    }
    if ((recommended.arrivalAt ?? 0) - Date.now() < requiredLead * 60_000) {
      setNotice('도착 시간이 가까워졌어요. 추천을 다시 확인해 주세요.');
      return { started: false, reason: 'stale_recommendation' };
    }
    sentAlerts.current = { prepare: false, depart: false };
    setAlertPhase('waiting');
    setAlertPlan(createAlertPlan(recommended, effectiveSettings));
    setNotice(
      '이 화면이 열려 있을 때 알려드려요. 화면을 끄거나 앱을 닫으면 알림이 멈출 수 있어요.',
    );
    setStatusMessage(
      recommended.route + '번 버스의 준비·출발 알림을 시작했어요.',
    );
    announce('알림을 켰어요. ' + recommendationText, true);
    return {
      started: true,
      route: recommended.route,
      preparationInMinutes: Math.max(0, prepOffset ?? 0),
      departureInMinutes: Math.max(0, departureOffset ?? 0),
    };
  }, [
    announce,
    departureOffset,
    destination,
    prepOffset,
    recommendationText,
    recommended,
    trip,
    requiredLead,
    effectiveSettings,
  ]);

  useEffect(() => {
    const initializationFrame = window.requestAnimationFrame(() => {
      setClockNow(Date.now());
      try {
        const saved = window.localStorage.getItem('bus-majung-settings');
        if (saved) setSettings(restoreSettings(JSON.parse(saved)));
      } catch {
        setNotice('설정을 불러오지 못해 기본값을 사용해요.');
      }
      setSettingsLoaded(true);
    });
    const clockTimer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    const loadVoices = () => {
      if ('speechSynthesis' in window) {
        setAvailableVoices(window.speechSynthesis.getVoices());
      }
    };
    loadVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleInstall);
    return () => {
      assistantRequestRef.current?.abort();
      locationRequestRef.current?.abort();
      window.cancelAnimationFrame(initializationFrame);
      window.clearInterval(clockTimer);
      window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
      window.removeEventListener('beforeinstallprompt', handleInstall);
      if (assistantCloseTimerRef.current !== null) {
        window.clearTimeout(assistantCloseTimerRef.current);
      }
      if (voiceLimitTimerRef.current !== null) {
        window.clearTimeout(voiceLimitTimerRef.current);
      }
      if (voiceRestartTimerRef.current !== null) {
        window.clearTimeout(voiceRestartTimerRef.current);
      }
      if (voiceFinalTimerRef.current !== null)
        window.clearTimeout(voiceFinalTimerRef.current);
      voiceSessionIdRef.current += 1;
      voicePressActiveRef.current = false;
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      try {
        if (recognition?.abort) recognition.abort();
        else recognition?.stop();
      } catch {
        // The browser may already have closed the recognition session.
      }
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    try {
      window.localStorage.setItem(
        'bus-majung-settings',
        JSON.stringify(settings),
      );
    } catch {
      window.setTimeout(() =>
        setNotice('이 브라우저에서는 설정을 저장할 수 없어요.'),
      );
    }
  }, [settings, settingsLoaded]);

  useEffect(() => {
    if (!destination || origin.id === 'unset') return;
    const selectedDestination = destination;

    const controller = new AbortController();

    const requestUrl = new URL('/api/routes', window.location.origin);
    requestUrl.searchParams.set('originLat', String(origin.latitude));
    requestUrl.searchParams.set('originLng', String(origin.longitude));
    requestUrl.searchParams.set('originName', origin.name);
    requestUrl.searchParams.set(
      'destinationLat',
      String(selectedDestination.latitude),
    );
    requestUrl.searchParams.set(
      'destinationLng',
      String(selectedDestination.longitude),
    );
    requestUrl.searchParams.set('destinationName', selectedDestination.name);
    requestUrl.searchParams.set(
      'demo',
      origin.id.startsWith('demo-') &&
        selectedDestination.id.startsWith('demo-')
        ? '1'
        : '0',
    );

    async function loadTrip() {
      setTripBusy(true);
      setTripError(null);
      setTracking(false);
      setTrip(null);
      setAlternativeTrips([]);
      setBuses([]);
      setStatusMessage('가는 길을 찾고 있어요.');
      try {
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('route fetch failed');
        const payload = (await response.json()) as {
          mode: 'demo' | 'live' | 'unavailable';
          trip: TripPlan | null;
          notice?: string;
          alternatives?: TripPlan[];
        };
        if (!payload.trip) {
          setTripMode('unavailable');
          setTripError(payload.notice ?? '직행 저상버스 경로를 찾지 못했어요.');
          setStatusMessage(
            payload.notice ?? '직행 저상버스 경로를 찾지 못했어요.',
          );
          return;
        }
        setTrip(payload.trip);
        setAlternativeTrips(payload.alternatives ?? []);
        setTripMode(payload.mode);
        setSelectedStop({
          id: payload.trip.boardingStop.id,
          name: payload.trip.boardingStop.name,
          direction: payload.trip.direction,
          route: payload.trip.route,
          cityCode: payload.trip.boardingStop.cityCode,
        });
        setStatusMessage(
          payload.mode === 'live'
            ? '도착지까지 가는 버스 경로를 찾았어요.'
            : '예시 경로를 보여드려요.',
        );
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setTripMode('unavailable');
          setTripError('연결이 끊겼어요. 다시 확인해 주세요.');
          setStatusMessage('경로를 불러오지 못했어요.');
        }
      } finally {
        if (!controller.signal.aborted) setTripBusy(false);
      }
    }

    void loadTrip();
    return () => controller.abort();
  }, [destination, origin]);

  useEffect(() => {
    if (!trip) return;
    const controller = new AbortController();
    let busy = false;
    async function loadBuses() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      setBusesBusy(true);
      try {
        const requestUrl =
          '/api/buses?route=' +
          encodeURIComponent(selectedStop.route) +
          '&nodeId=' +
          encodeURIComponent(selectedStop.id) +
          '&cityCode=' +
          encodeURIComponent(selectedStop.cityCode ?? '') +
          '&demo=' +
          (tripMode === 'demo' ? '1' : '0');
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('bus fetch failed');
        const payload = (await response.json()) as {
          mode: 'demo' | 'live' | 'unavailable';
          buses: BusCandidate[];
          refreshedAt: string;
        };
        if (controller.signal.aborted) return;
        const fetchedAt = Date.parse(payload.refreshedAt);
        if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 90_000)
          throw new Error('stale arrivals');
        setBuses(stampArrivals(payload.buses, fetchedAt));
        setClockNow(Date.now());
        setLastUpdatedAt(fetchedAt);
        setDataMode(payload.mode);
        setStatusMessage(
          payload.mode === 'live'
            ? '버스 도착 정보를 갱신했어요.'
            : payload.mode === 'demo'
              ? '체험용 경로예요. 실제 이동에는 사용할 수 없어요.'
              : '저상버스 도착 정보를 확인하지 못했어요.',
        );
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setBuses([]);
          setDataMode('unavailable');
          setStatusMessage(
            '도착 정보를 불러오지 못했어요. 30초 뒤 다시 확인할게요.',
          );
        }
      } finally {
        busy = false;
        if (!controller.signal.aborted) setBusesBusy(false);
      }
    }
    void loadBuses();
    // Demo arrivals stay anchored to their first response instead of resetting every poll.
    const timer =
      tripMode === 'live'
        ? window.setInterval(() => {
            if (document.visibilityState === 'visible') void loadBuses();
          }, 30_000)
        : null;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible' && tripMode === 'live')
        void loadBuses();
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('online', refreshOnReturn);
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.removeEventListener('online', refreshOnReturn);
    };
  }, [selectedStop, trip, tripMode]);

  useEffect(() => {
    if (!alertPlan || !trip) return;
    const checkAlerts = () => {
      if (alertPlan.settingsKey !== timingKey(effectiveSettings)) {
        setAlertPlan(null);
        setNotice('이동 시간이 바뀌었어요. 새 추천으로 알림을 다시 켜 주세요.');
        return;
      }
      if (
        dataMode === 'unavailable' ||
        (dataMode === 'live' &&
          lastUpdatedAt !== null &&
          Date.now() - lastUpdatedAt > 90_000)
      ) {
        setAlertPlan(null);
        setNotice(
          '최신 도착 정보를 확인하지 못해 알림을 멈췄어요. 다시 확인해 주세요.',
        );
        return;
      }
      const now = Date.now();
      if (now >= (alertPlan.bus.arrivalAt ?? 0)) {
        setAlertPlan(null);
        setNotice(
          '예상 도착 시각이 지났어요. 탑승 여부와 최신 정보를 확인해 주세요.',
        );
        return;
      }
      const event = dueAlert(alertPlan, now, sentAlerts.current);
      if (event === 'expired') {
        setAlertPlan(null);
        setNotice('출발 예정 시각이 지났어요. 최신 버스로 다시 확인해 주세요.');
      } else if (event === 'depart') {
        sentAlerts.current.depart = true;
        sentAlerts.current.prepare = true;
        setAlertPhase('depart');
        notify(
          '지금 출발하세요',
          trip.boardingStop.name +
            '에서 ' +
            trip.direction +
            ' ' +
            alertPlan.bus.route +
            '번 버스를 타세요.',
        );
      } else if (event === 'prepare') {
        sentAlerts.current.prepare = true;
        setAlertPhase('prepare');
        notify(
          '준비를 시작하세요',
          settings.preparationMinutes + '분 뒤 출발할 시간이에요.',
        );
      }
    };
    const frame = window.requestAnimationFrame(checkAlerts);
    const timer = window.setInterval(checkAlerts, 1_000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [
    alertPlan,
    dataMode,
    effectiveSettings,
    lastUpdatedAt,
    notify,
    settings.preparationMinutes,
    trip,
  ]);

  useEffect(() => {
    if (
      !alertPlan ||
      sentAlerts.current.depart ||
      buses.length === 0 ||
      alertPlan.settingsKey !== timingKey(effectiveSettings)
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const now = Date.now();
      const prepRemaining = sentAlerts.current.prepare
        ? Math.max(
            0,
            effectiveSettings.preparationMinutes -
              (now - alertPlan.prepareAt) / 60_000,
          )
        : effectiveSettings.preparationMinutes;
      const next = getRecommendation(
        buses,
        { ...effectiveSettings, preparationMinutes: prepRemaining },
        now,
      ).recommended;
      if (!next) {
        setAlertPlan(null);
        setNotice(
          '버스 도착 시간이 바뀌어 알림을 멈췄어요. 다음 버스를 확인해 주세요.',
        );
        return;
      }
      if (
        next.arrivalAt === alertPlan.bus.arrivalAt &&
        next.id === alertPlan.bus.id
      )
        return;
      const plan = createAlertPlan(next, effectiveSettings);
      if (sentAlerts.current.prepare) plan.prepareAt = alertPlan.prepareAt;
      setAlertPlan(plan);
      if (Math.abs(plan.departAt - alertPlan.departAt) >= 60_000) {
        const message =
          '버스 도착 시간이 바뀌었어요. ' +
          formatClock(0, plan.departAt) +
          '에 출발하도록 알림을 바꿨어요.';
        setNotice(message);
        announce(message, true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [alertPlan, announce, buses, effectiveSettings]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool(
        {
          name: 'preview_accessible_bus_recommendation',
          title: '저상버스 추천 계산',
          description:
            '준비시간, 정류장 이동시간, 안전 여유시간을 반영해 탑승 가능한 저상버스를 계산하고 화면에 표시합니다.',
          inputSchema: {
            type: 'object',
            properties: {
              preparationMinutes: { type: 'integer', minimum: 0, maximum: 30 },
              travelMinutes: { type: 'integer', minimum: 1, maximum: 60 },
              safetyMinutes: { type: 'integer', minimum: 1, maximum: 15 },
            },
            required: ['preparationMinutes', 'travelMinutes', 'safetyMinutes'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            if (!input || typeof input !== 'object')
              throw new Error('입력 형식을 확인해 주세요.');
            const value = input as Partial<Settings>;
            const numbers = [
              value.preparationMinutes,
              value.travelMinutes,
              value.safetyMinutes,
            ];
            if (numbers.some((number) => !Number.isInteger(number))) {
              throw new Error('모든 시간은 정수 분 단위여야 합니다.');
            }
            const nextSettings: Settings = {
              ...settings,
              preparationMinutes: value.preparationMinutes as number,
              travelMinutes: value.travelMinutes as number,
              safetyMinutes: value.safetyMinutes as number,
              automaticTravelTime: false,
            };
            if (
              nextSettings.preparationMinutes < 0 ||
              nextSettings.preparationMinutes > 30 ||
              nextSettings.travelMinutes < 1 ||
              nextSettings.travelMinutes > 60 ||
              nextSettings.safetyMinutes < 1 ||
              nextSettings.safetyMinutes > 15
            ) {
              throw new Error('입력 시간이 허용 범위를 벗어났습니다.');
            }
            setSettings(nextSettings);
            const nextResult = getRecommendation(
              buses,
              nextSettings,
              Date.now(),
            );
            setStatusMessage('새로운 이동시간으로 추천을 다시 계산했어요.');
            return {
              route: nextResult.recommended?.route ?? null,
              etaMinutes: nextResult.recommended?.etaMinutes ?? null,
              requiredLeadMinutes: nextResult.requiredLead,
            };
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: 'start_departure_alerts',
          title: '준비·출발 알림 시작',
          description:
            '현재 화면에서 추천한 저상버스를 기준으로 준비 시작과 출발 알림을 활성화합니다.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: startAlerts,
        },
        { signal: lifecycle.signal },
      );
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [buses, settings, startAlerts]);

  const openPlacePicker = (kind: 'origin' | 'destination') => {
    locationRequestRef.current?.abort();
    locationRequestRef.current = null;
    setPlaceBusy(false);
    setVoiceChoiceActive(false);
    assistantRequestRef.current?.abort();
    voiceDraftRef.current = null;
    voiceCandidatesRef.current = [];
    setPlacePicker(kind);
    setPlaceQuery('');
    const selected = kind === 'origin' ? origin : destination;
    setPlaceResults(selected && selected.id !== 'unset' ? [selected] : []);
    setPlaceMessage('장소 이름이나 주소를 검색해 주세요.');
  };

  const selectPlace = (place: Place, slot = placePicker) => {
    if (!slot) return;
    locationRequestRef.current?.abort();
    locationRequestRef.current = null;
    setPlaceBusy(false);
    if (voiceDraftRef.current?.pendingSlot === slot) {
      // A confirmed origin must not wait for destination lookup or an AI call.
      if (slot === 'origin') {
        setOrigin(place);
        setTracking(false);
        setTrip(null);
        setTripError(null);
        setBuses([]);
        voiceDraftRef.current = { ...voiceDraftRef.current, origin: place };
      }
      setPlacePicker(null);
      setAssistantOpen(true);
      void runAssistant(assistantInput, place);
      return;
    }
    const selected = slot === 'origin' ? origin : destination;
    if (selected && selected.id !== 'unset' && isSamePlace(place, selected)) {
      setPlacePicker(null);
      return;
    }
    setTracking(false);
    setTrip(null);
    setTripError(null);
    setBuses([]);
    if (slot === 'origin') {
      setOrigin(place);
      if (destination?.id === place.id) setDestination(null);
      setStatusMessage(place.name + '에서 출발할게요.');
    } else {
      setDestination(place);
      setStatusMessage(place.name + '까지 가는 길을 찾을게요.');
    }
    setPlacePicker(
      slot === 'destination' && origin.id === 'unset' ? 'origin' : null,
    );
  };

  const searchPlaces = async () => {
    const query = placeQuery.trim();
    if (!query || placeBusy) return;
    setPlaceBusy(true);
    setPlaceMessage('장소를 찾고 있어요…');
    try {
      const payload = await requestPlaceMatches(query, origin);
      setPlaceResults(payload.places);
      if (voiceDraftRef.current?.pendingSlot) {
        voiceCandidatesRef.current = payload.places;
        setVoiceChoiceActive(payload.places.length > 0);
      }
      setPlaceMessage(
        payload.places.length > 0
          ? payload.mode === 'live'
            ? '검색어와 관련 있는 장소예요. 주소를 확인해 주세요.'
            : '장소 검색 연결 전이라 체험용 장소만 보여드려요.'
          : placeSearchFailure(
              payload.mode,
              query,
              placePicker ?? 'destination',
            ),
      );
    } catch {
      setPlaceResults([]);
      setPlaceMessage(
        '장소 검색에 연결하지 못했어요. 잠시 후 다시 검색해 주세요.',
      );
    } finally {
      setPlaceBusy(false);
    }
  };

  const useCurrentLocation = () => {
    if (placeBusy) return;
    locationRequestRef.current?.abort();
    const request = new AbortController();
    locationRequestRef.current = request;
    setPlaceBusy(true);
    setPlaceMessage('현재 위치를 확인하고 있어요…');
    void requestCurrentLocation(request.signal)
      .then((place) => {
        if (request.signal.aborted) return;
        selectPlace(place, 'origin');
      })
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        const message = locationErrorMessage(error);
        setPlaceMessage(message);
        setStatusMessage(message);
      })
      .finally(() => {
        if (locationRequestRef.current === request) {
          locationRequestRef.current = null;
          setPlaceBusy(false);
        }
      });
  };

  const runAssistant = async (message: string, chosenPlace?: Place) => {
    const cleanMessage = message.trim();
    if (!cleanMessage || assistantBusy) return;
    if (cleanMessage.length > 300) {
      setAssistantReply(
        '말한 내용이 길어요. 글로 입력에서 장소 이름 위주로 줄여 주세요.',
      );
      setEditingVoiceText(true);
      return;
    }
    assistantRequestRef.current?.abort();
    const request = new AbortController();
    assistantRequestRef.current = request;
    setEditingVoiceText(false);
    if (assistantCloseTimerRef.current !== null) {
      window.clearTimeout(assistantCloseTimerRef.current);
      assistantCloseTimerRef.current = null;
    }
    setAssistantBusy(true);
    setAssistantReply('요청을 이해하고 필요한 정보를 확인하고 있어요…');
    setStatusMessage('AI 도우미가 요청을 분석하고 있어요.');
    try {
      let spokenOrigin: Place | null = null;
      let spokenDestination: Place | null = null;
      const pending = voiceDraftRef.current;
      const candidate =
        chosenPlace ??
        (pending?.pendingSlot
          ? candidateFromSpeech(cleanMessage, voiceCandidatesRef.current)
          : null);
      let queries = parseRouteFollowUp(
        cleanMessage,
        pending?.pendingSlot ?? null,
      );
      if (!candidate) {
        const intentResponse = await fetch('/api/voice-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: cleanMessage,
            pendingSlot: pending?.pendingSlot ?? null,
          }),
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!intentResponse.ok) {
          setAssistantReply(
            intentResponse.status === 429
              ? '요청이 많아요. 잠시 후 다시 말해 주세요.'
              : '말한 내용을 확인하지 못했어요. 다시 시도해 주세요.',
          );
          return;
        }
        const intent = (await intentResponse.json()) as VoiceIntent & {
          mode: 'local' | 'model';
          reason?: string;
        };
        if (request.signal.aborted) return;
        setVoiceModeNotice(
          intent.mode === 'model'
            ? 'AI로 문장을 해석했어요.'
            : intent.reason === 'model_unavailable'
              ? 'AI 연결이 어려워 기본 문장 해석을 사용했어요.'
              : '현재 기본 문장 해석을 사용하고 있어요.',
        );
        queries = intent;
        if (intent.clarification) {
          const literal = parseRouteFollowUp(
            cleanMessage,
            pending?.pendingSlot ?? null,
          );
          const draft = mergeVoiceDraft(
            pending,
            {
              originQuery: queries.originQuery || literal.originQuery,
              destinationQuery:
                queries.destinationQuery || literal.destinationQuery,
            },
            origin.id === 'unset' ? null : origin,
            destination,
          );
          draft.pendingSlot = /^(우리\s*)?(집|회사|거기|저기|병원)$/.test(
            draft.originQuery,
          )
            ? 'origin'
            : /^(우리\s*)?(집|회사|거기|저기|병원)$/.test(
                  draft.destinationQuery,
                )
              ? 'destination'
              : (pending?.pendingSlot ?? null);
          voiceDraftRef.current = draft;
          const question = draft.pendingSlot
            ? intent.clarification
            : '출발지와 도착지를 정확히 나누지 못했어요. “서울역에서 강남역까지”처럼 다시 말해 주세요.';
          setAssistantReply(question);
          announce(question);
          return;
        }
      }
      if (candidate || queries.originQuery || queries.destinationQuery) {
        let draft = mergeVoiceDraft(
          pending,
          candidate ? { originQuery: '', destinationQuery: '' } : queries,
          origin.id === 'unset' ? null : origin,
          destination,
        );
        if (candidate && draft.pendingSlot)
          draft = { ...draft, [draft.pendingSlot]: candidate };
        voiceDraftRef.current = draft;
        const resolution = await resolveVoiceDraft(draft, {
          search: (query, center) =>
            requestPlaceMatches(query, center, request.signal),
          locate: () => requestCurrentLocation(request.signal),
        });
        if (request.signal.aborted) return;
        voiceDraftRef.current = resolution.draft;
        if (resolution.kind !== 'complete') {
          setAssistantReply(resolution.message);
          setStatusMessage(resolution.message);
          announce(resolution.message);
          if (resolution.kind === 'choose') {
            setVoiceChoiceActive(true);
            voiceCandidatesRef.current = resolution.places;
            setPlaceResults(resolution.places);
            setPlaceQuery(
              resolution.slot === 'origin'
                ? resolution.draft.originQuery
                : resolution.draft.destinationQuery,
            );
            setPlaceMessage(resolution.message);
            setAssistantOpen(false);
            setPlacePicker(resolution.slot);
          } else {
            setVoiceChoiceActive(false);
            voiceCandidatesRef.current = [];
          }
          return;
        }
        spokenOrigin = resolution.origin;
        spokenDestination = resolution.destination;
      }

      const availablePlaces = [
        ...(spokenOrigin ? [spokenOrigin] : []),
        ...(spokenDestination ? [spokenDestination] : []),
        origin,
        ...(destination ? [destination] : []),
        ...placeResults,
        ...demoPlaces,
      ].filter(
        (place, index, places) =>
          places.findIndex((candidate) => candidate.id === place.id) === index,
      );
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: cleanMessage,
          currentStop: selectedStop,
          availableStops: [selectedStop],
          currentOrigin: origin,
          currentDestination: destination,
          availablePlaces,
          spokenOriginPlaceId: spokenOrigin?.id,
          spokenDestinationPlaceId: spokenDestination?.id,
          settings,
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      const payload = (await response.json()) as AssistantResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? 'assistant request failed');
      if (request.signal.aborted) return;

      const nextOrigin = availablePlaces.find(
        (place) => place.id === payload.changes.originPlaceId,
      );
      const nextDestination = availablePlaces.find(
        (place) => place.id === payload.changes.destinationPlaceId,
      );
      const placeChanged = Boolean(nextOrigin || nextDestination);
      if (placeChanged) {
        setTrip(null);
        setBuses([]);
        setTracking(false);
      }
      if (nextOrigin) setOrigin(nextOrigin);
      if (nextDestination) setDestination(nextDestination);
      if (spokenOrigin && spokenDestination && !payload.needsClarification) {
        setVoiceChoiceActive(false);
        voiceDraftRef.current = null;
        voiceCandidatesRef.current = [];
      }
      if (nextDestination && !nextOrigin && origin.id === 'unset') {
        setAssistantOpen(false);
        setPlacePicker('origin');
        setPlaceMessage('출발할 장소를 골라 주세요.');
      }

      if (payload.changes.stopId) {
        const nextStop =
          selectedStop.id === payload.changes.stopId ? selectedStop : null;
        if (nextStop) {
          setSelectedStop(nextStop);
          setTracking(false);
        }
      }
      setSettings((current) => ({
        ...current,
        ...(payload.changes.preparationMinutes !== undefined
          ? { preparationMinutes: payload.changes.preparationMinutes }
          : {}),
        ...(payload.changes.travelMinutes !== undefined
          ? {
              travelMinutes: payload.changes.travelMinutes,
              automaticTravelTime: false,
            }
          : {}),
        ...(payload.changes.safetyMinutes !== undefined
          ? { safetyMinutes: payload.changes.safetyMinutes }
          : {}),
      }));
      setAssistantReply(payload.responseText);
      setStatusMessage(
        payload.needsClarification
          ? '한 가지를 더 확인해 주세요.'
          : '말한 내용을 반영했어요.',
      );
      announce(payload.responseText);
      if (
        !payload.needsClarification &&
        Object.keys(payload.changes).length > 0
      ) {
        if (assistantCloseTimerRef.current !== null) {
          window.clearTimeout(assistantCloseTimerRef.current);
        }
        assistantCloseTimerRef.current = window.setTimeout(() => {
          setAssistantOpen(false);
          assistantCloseTimerRef.current = null;
        }, 4500);
      }
    } catch {
      if (request.signal.aborted) return;
      setAssistantReply(
        '잠시 연결이 불안정해요. 현재 화면의 추천은 계속 이용할 수 있어요.',
      );
      setStatusMessage('AI 도우미 연결이 어려워 기존 추천을 유지했어요.');
    } finally {
      if (assistantRequestRef.current === request) {
        assistantRequestRef.current = null;
        setAssistantBusy(false);
      }
    }
  };

  const clearVoiceTimers = useCallback(() => {
    if (voiceFinalTimerRef.current !== null) {
      window.clearTimeout(voiceFinalTimerRef.current);
      voiceFinalTimerRef.current = null;
    }
    if (voiceLimitTimerRef.current !== null) {
      window.clearTimeout(voiceLimitTimerRef.current);
      voiceLimitTimerRef.current = null;
    }
    if (voiceRestartTimerRef.current !== null) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
  }, []);

  const stopListening = useCallback(() => {
    if (
      !voicePressActiveRef.current &&
      finishVoiceSessionRef.current === null
    ) {
      return;
    }

    voicePressActiveRef.current = false;
    if (voiceLimitTimerRef.current !== null) {
      window.clearTimeout(voiceLimitTimerRef.current);
      voiceLimitTimerRef.current = null;
    }
    setStatusMessage('말한 경로를 확인하고 있어요.');

    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
        voiceFinalTimerRef.current = window.setTimeout(
          () => finishVoiceSessionRef.current?.(),
          1500,
        );
        return;
      } catch {
        recognitionRef.current = null;
      }
    }

    if (voiceRestartTimerRef.current !== null) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    finishVoiceSessionRef.current?.();
  }, []);

  const cancelListening = useCallback(() => {
    const recognition = recognitionRef.current;
    voiceSessionIdRef.current += 1;
    voicePressActiveRef.current = false;
    voicePointerIdRef.current = null;
    voiceKeyboardActiveRef.current = false;
    finishVoiceSessionRef.current = null;
    recognitionRef.current = null;
    clearVoiceTimers();
    if (recognition) {
      try {
        if (recognition.abort) recognition.abort();
        else recognition.stop();
      } catch {
        // The browser may already have closed the recognition session.
      }
    }
    setListening(false);
  }, [clearVoiceTimers]);

  const startListening = () => {
    if (
      voicePressActiveRef.current ||
      voiceSubmittingRef.current ||
      assistantBusy
    ) {
      return;
    }
    if (assistantCloseTimerRef.current !== null) {
      window.clearTimeout(assistantCloseTimerRef.current);
      assistantCloseTimerRef.current = null;
    }
    setAssistantOpen(true);
    setEditingVoiceText(false);
    setAssistantInput('');
    voiceTranscriptRef.current = '';

    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      const message =
        '이 브라우저는 말하기를 지원하지 않아요. 출발지와 도착지를 눌러 직접 선택해 주세요.';
      setStatusMessage(message);
      setAssistantReply(message);
      return;
    }

    const sessionId = voiceSessionIdRef.current + 1;
    voiceSessionIdRef.current = sessionId;
    voicePressActiveRef.current = true;
    window.speechSynthesis?.cancel();
    setListening(true);
    setAssistantReply('듣고 있어요… 출발지와 도착지를 이어서 말해 주세요.');
    setStatusMessage('버튼을 누르고 있는 동안 음성을 듣고 있어요.');

    let submitted = false;
    let fatalError = false;
    let endedByLimit = false;
    let committedTranscript = '';
    const deadline = Date.now() + 15_000;

    const submitTranscript = () => {
      if (submitted || voiceSessionIdRef.current !== sessionId) return;
      submitted = true;
      finishVoiceSessionRef.current = null;
      try {
        recognitionRef.current?.abort?.();
      } catch {
        /* Recognition may already be closed. */
      }
      recognitionRef.current = null;
      voicePressActiveRef.current = false;
      voiceKeyboardActiveRef.current = false;
      clearVoiceTimers();
      setListening(false);

      const transcript = voiceTranscriptRef.current.trim();
      if (!transcript) {
        const message = endedByLimit
          ? '15초 동안 음성을 듣지 못했어요. 버튼을 누른 채 다시 말해 주세요.'
          : '말소리가 들리지 않았어요. 버튼을 누른 채 다시 말해 주세요.';
        setAssistantReply(message);
        setStatusMessage(message);
        return;
      }

      voiceSubmittingRef.current = true;
      if (endedByLimit) {
        setStatusMessage('15초가 되어 듣기를 마쳤어요. 경로를 확인할게요.');
      }
      void runAssistant(transcript).finally(() => {
        voiceSubmittingRef.current = false;
      });
    };
    finishVoiceSessionRef.current = submitTranscript;

    const launchRecognition = () => {
      if (voiceSessionIdRef.current !== sessionId || submitted || fatalError) {
        return;
      }
      if (!voicePressActiveRef.current || Date.now() >= deadline) {
        submitTranscript();
        return;
      }

      const recognition = new Recognition();
      let cycleTranscript = '';
      recognition.lang = 'ko-KR';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        if (voiceSessionIdRef.current !== sessionId || submitted) return;
        cycleTranscript = readRecognitionTranscript(event);
        const transcript = [committedTranscript, cycleTranscript]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        voiceTranscriptRef.current = transcript;
        setAssistantInput(transcript);
      };
      recognition.onerror = (event) => {
        if (
          voiceSessionIdRef.current !== sessionId ||
          event.error === 'no-speech' ||
          event.error === 'aborted'
        ) {
          return;
        }

        fatalError = true;
        voicePressActiveRef.current = false;
        finishVoiceSessionRef.current = null;
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }
        clearVoiceTimers();
        const message =
          event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? '마이크 권한이 필요해요. 브라우저 설정에서 마이크를 허용해 주세요.'
            : event.error === 'audio-capture'
              ? '마이크를 찾지 못했어요. 기기의 마이크 설정을 확인해 주세요.'
              : '음성을 알아듣지 못했어요. 버튼을 누른 채 다시 말해 주세요.';
        setListening(false);
        setStatusMessage(message);
        setAssistantReply(message);
      };
      recognition.onend = () => {
        if (voiceSessionIdRef.current !== sessionId || submitted) return;
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }
        if (cycleTranscript) {
          committedTranscript = [committedTranscript, cycleTranscript]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          voiceTranscriptRef.current = committedTranscript;
          setAssistantInput(committedTranscript);
        }
        if (fatalError) {
          setListening(false);
          return;
        }
        if (voicePressActiveRef.current && Date.now() < deadline) {
          voiceRestartTimerRef.current = window.setTimeout(() => {
            voiceRestartTimerRef.current = null;
            launchRecognition();
          }, 80);
          return;
        }
        submitTranscript();
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
        fatalError = true;
        voicePressActiveRef.current = false;
        finishVoiceSessionRef.current = null;
        clearVoiceTimers();
        setListening(false);
        const message =
          '마이크를 시작하지 못했어요. 잠시 후 버튼을 다시 눌러 주세요.';
        setAssistantReply(message);
        setStatusMessage(message);
      }
    };

    voiceLimitTimerRef.current = window.setTimeout(() => {
      if (voiceSessionIdRef.current !== sessionId || submitted) return;
      endedByLimit = true;
      voicePressActiveRef.current = false;
      const recognition = recognitionRef.current;
      if (recognition) {
        try {
          recognition.stop();
          voiceFinalTimerRef.current = window.setTimeout(
            submitTranscript,
            1500,
          );
          return;
        } catch {
          recognitionRef.current = null;
        }
      }
      if (voiceRestartTimerRef.current !== null) {
        window.clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = null;
      }
      submitTranscript();
    }, 15_000);

    launchRecognition();
  };

  const beginVoicePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (tapToTalk) return;
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    voiceClickSuppressedRef.current = true;
    voicePointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A global pointer-up listener remains as a fallback.
    }
    startListening();
  };

  const endVoicePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (voicePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    voicePointerIdRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Releasing an already-lost capture is safe to ignore.
    }
    stopListening();
  };

  const cancelVoicePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (voicePointerIdRef.current !== event.pointerId) return;
    voicePointerIdRef.current = null;
    voiceClickSuppressedRef.current = false;
    cancelListening();
  };

  const handleVoiceKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapToTalk) return;
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
    event.preventDefault();
    voiceClickSuppressedRef.current = true;
    voiceKeyboardActiveRef.current = true;
    startListening();
  };

  const handleVoiceKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (tapToTalk) return;
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    voiceKeyboardActiveRef.current = false;
    stopListening();
    window.setTimeout(() => {
      voiceClickSuppressedRef.current = false;
    }, 0);
  };

  const handleVoiceClick = () => {
    if (voiceClickSuppressedRef.current) {
      voiceClickSuppressedRef.current = false;
      return;
    }
    if (voicePressActiveRef.current) stopListening();
    else startListening();
  };

  useEffect(() => {
    const handleGlobalPointerUp = (event: PointerEvent) => {
      if (voicePointerIdRef.current !== event.pointerId) return;
      voicePointerIdRef.current = null;
      stopListening();
      window.setTimeout(() => {
        voiceClickSuppressedRef.current = false;
      }, 0);
    };
    const handleGlobalKeyUp = (event: KeyboardEvent) => {
      if (
        !voiceKeyboardActiveRef.current ||
        (event.key !== ' ' && event.key !== 'Enter')
      ) {
        return;
      }
      voiceKeyboardActiveRef.current = false;
      stopListening();
      window.setTimeout(() => {
        voiceClickSuppressedRef.current = false;
      }, 0);
    };
    const handleGlobalPointerCancel = (event: PointerEvent) => {
      if (voicePointerIdRef.current !== event.pointerId) return;
      voiceClickSuppressedRef.current = false;
      cancelListening();
    };
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'hidden' &&
        voicePressActiveRef.current
      ) {
        cancelListening();
      }
    };
    // Opening the dialog can release pointer capture without releasing the
    // finger. Only an actual release/cancel (or the 15-second limit) ends a hold.
    window.addEventListener('pointerup', handleGlobalPointerUp, true);
    window.addEventListener('pointercancel', handleGlobalPointerCancel, true);
    window.addEventListener('keyup', handleGlobalKeyUp);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp, true);
      window.removeEventListener(
        'pointercancel',
        handleGlobalPointerCancel,
        true,
      );
      window.removeEventListener('keyup', handleGlobalKeyUp);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [cancelListening, stopListening]);

  const simulateArrivalChange = () => {
    if (!recommended) return;
    setBuses((current) =>
      current.map((bus) =>
        bus.id === recommended.id
          ? { ...bus, arrivalAt: (bus.arrivalAt ?? Date.now()) - 8 * 60_000 }
          : bus,
      ),
    );
    setStatusMessage(
      '도착시간이 앞당겨졌어요. 더 여유로운 다음 저상버스를 다시 추천합니다.',
    );
    announce(
      '버스 도착이 빨라져 기존 차량은 여유가 부족합니다. 다음 저상버스를 다시 추천할게요.',
    );
  };

  const installApp = async () => {
    if (!installPrompt) {
      setNotice(
        '아이폰은 Safari 공유 메뉴 → 홈 화면에 추가, 안드로이드는 브라우저 메뉴 → 앱 설치를 선택해 주세요.',
      );
      setSettingsOpen(false);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setStatusMessage(
      choice.outcome === 'accepted'
        ? '홈 화면에 버스마중을 설치했어요.'
        : '설치를 다음으로 미뤘어요.',
    );
    setInstallPrompt(null);
  };

  const submitFeedback = (feedback: 'comfortable' | 'rushed' | 'missed') => {
    if (feedback === 'rushed') {
      setSettings((current) => ({
        ...current,
        safetyMinutes: Math.min(15, current.safetyMinutes + 1),
      }));
    }
    if (feedback === 'missed') {
      setSettings((current) => ({
        ...current,
        travelMinutes: Math.min(60, current.travelMinutes + 2),
      }));
    }
    setFeedbackComplete(true);
    setStatusMessage('다음 추천에 이동 결과를 반영했어요.');
  };

  return (
    <main className="min-h-dvh bg-[#F2F4F6] text-[#191F28]">
      <div className="mx-auto min-h-dvh w-full max-w-[480px] bg-white shadow-[0_0_48px_rgba(0,0,0,0.06)]">
        <header className="border-b border-[#F2F4F6] bg-white px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-[#191F28]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="grid size-11 place-items-center rounded-xl bg-[#2165D6] text-white">
                <BusFront
                  aria-hidden="true"
                  className="size-6"
                  strokeWidth={2.4}
                />
              </span>
              <h1 className="text-xl font-bold tracking-[-0.02em]">버스마중</h1>
            </div>
            <div className="flex items-center gap-2">
              {displayMode !== 'demo' && (
                <span
                  className={
                    'rounded-full px-3 py-1.5 text-sm font-semibold ' +
                    (displayMode === 'live'
                      ? 'bg-[#E8F8F0] text-[#18794E]'
                      : displayMode === 'unavailable'
                        ? 'bg-[#FFF0F0] text-[#CD2B31]'
                        : 'bg-[#F2F4F6] text-[#6B7684]')
                  }
                >
                  {displayMode === 'live'
                    ? '실시간'
                    : displayMode === 'unavailable'
                      ? '확인 필요'
                      : '확인 중'}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="grid size-12 place-items-center rounded-2xl bg-[#F2F4F6] text-[#4E5968] hover:bg-[#E5E8EB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
                aria-label="내 이동시간과 알림 설정 열기"
              >
                <Settings2 aria-hidden="true" className="size-6" />
              </button>
            </div>
          </div>

          <div className="mt-5 flex overflow-hidden rounded-2xl bg-[#F2F4F6]">
            <div className="min-w-0 flex-1 px-4">
              <button
                type="button"
                onClick={() => openPlacePicker('origin')}
                className="flex min-h-[4.5rem] w-full items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
                aria-label={'출발지 변경. 현재 ' + origin.name}
              >
                <span
                  aria-hidden="true"
                  className="grid size-6 shrink-0 place-items-center"
                >
                  <span className="size-3 rounded-full border-[3px] border-[#2165D6] bg-white" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[#6B7684]">
                    출발
                  </span>
                  <span className="mt-0.5 block truncate text-lg font-semibold">
                    {origin.name}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-5 shrink-0 text-[#647184]"
                />
              </button>

              <div className="relative ml-3 border-t border-[#E5E8EB]">
                <ArrowDown
                  aria-hidden="true"
                  className="absolute -left-3 -top-3 size-6 rounded-full bg-[#F2F4F6] p-1 text-[#647184]"
                />
                <button
                  type="button"
                  onClick={() => openPlacePicker('destination')}
                  className="flex min-h-[4.5rem] w-full items-center gap-3 pl-9 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
                  aria-label={
                    destination
                      ? '도착지 변경. 현재 ' + destination.name
                      : '도착지 선택'
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[#6B7684]">
                      도착
                    </span>
                    <span
                      className={
                        'mt-0.5 block truncate text-lg font-semibold ' +
                        (destination ? 'text-[#191F28]' : 'text-[#647184]')
                      }
                    >
                      {destination?.name ?? '어디로 갈까요?'}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-5 shrink-0 text-[#647184]"
                  />
                </button>
              </div>
            </div>

            <span id="voice-route-help" className="sr-only">
              버튼을 누르고 있는 동안 듣습니다. 최대 15초. 예: 현재 위치에서
              서울역까지
            </span>
            <button
              type="button"
              onPointerDown={beginVoicePointer}
              onPointerUp={endVoicePointer}
              onPointerCancel={cancelVoicePointer}
              onKeyDown={handleVoiceKeyDown}
              onKeyUp={handleVoiceKeyUp}
              onClick={handleVoiceClick}
              onContextMenu={(event) => event.preventDefault()}
              disabled={assistantBusy}
              className={
                'flex w-[4.75rem] touch-none select-none shrink-0 flex-col items-center justify-center gap-2 border-l border-[#E5E8EB] text-xs font-semibold leading-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#2165D6] disabled:cursor-wait ' +
                (listening
                  ? 'bg-[#E8F3FF] text-[#1B64DA]'
                  : 'text-[#4E5968] hover:bg-[#E5E8EB]')
              }
              aria-label={
                listening
                  ? '음성 인식 중. 손을 떼거나 다시 누르면 경로를 적용합니다'
                  : '누르고 있는 동안 출발지와 도착지 말하기. 최대 15초'
              }
              aria-describedby="voice-route-help"
              aria-pressed={listening}
            >
              <span className="grid size-11 place-items-center rounded-full bg-white text-[#2165D6]">
                <Mic
                  aria-hidden="true"
                  className={'size-6 ' + (listening ? 'animate-pulse' : '')}
                />
              </span>
              눌러 말하기
            </button>
          </div>
        </header>

        <section
          className="px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6"
          aria-labelledby="recommendation-title"
        >
          <output aria-live="polite" aria-atomic="true" className="sr-only">
            {statusMessage}
          </output>

          <article>
            {!destination || origin.id === 'unset' ? (
              <div className="py-10 text-left">
                <h2
                  id="recommendation-title"
                  className="text-[2rem] font-bold leading-tight tracking-[-0.03em]"
                >
                  어디로 갈까요?
                </h2>
                <p className="mt-2 text-lg leading-7 text-[#6B7684]">
                  출발지와 도착지를 정하면 가는 방향의 버스를 찾아드려요.
                </p>
                <Button
                  className="mt-6 h-16 w-full rounded-2xl bg-[#2165D6] text-lg font-semibold text-white hover:bg-[#1B64DA]"
                  onClick={() =>
                    openPlacePicker(destination ? 'origin' : 'destination')
                  }
                >
                  <Search aria-hidden="true" className="size-6" />
                  {destination ? '출발지 선택' : '도착지 찾기'}
                </Button>
                {!destination && (
                  <button
                    className="mt-3 min-h-12 w-full text-sm font-semibold text-[#4E5968]"
                    onClick={() => {
                      setOrigin(demoPlaces[0]);
                      setDestination(demoPlaces[1]);
                      setNotice(
                        '체험용 경로와 도착 시간이에요. 실제 이동에는 사용하지 마세요.',
                      );
                    }}
                  >
                    체험 경로로 둘러보기
                  </button>
                )}
              </div>
            ) : tripError ? (
              <div className="py-8 text-left">
                <h2
                  id="recommendation-title"
                  className="text-[2rem] font-bold leading-tight tracking-[-0.03em]"
                >
                  경로를 확인하지 못했어요
                </h2>
                <p className="mt-2 text-lg leading-7 text-[#6B7684]">
                  {tripError}
                </p>
                <Button
                  variant="outline"
                  className="mt-4 h-14 w-full"
                  onClick={() => setOrigin({ ...origin })}
                >
                  다시 확인하기
                </Button>
                <Button
                  className="mt-6 h-14 w-full rounded-2xl bg-[#2165D6] text-base font-semibold text-white hover:bg-[#1B64DA]"
                  onClick={() => openPlacePicker('destination')}
                >
                  <Search aria-hidden="true" />
                  도착지 다시 찾기
                </Button>
              </div>
            ) : tripBusy || !trip ? (
              <div
                className="flex min-h-72 flex-col items-center justify-center text-center"
                aria-busy="true"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-9 animate-spin text-[#2165D6]"
                />
                <h2
                  id="recommendation-title"
                  className="mt-5 text-2xl font-bold tracking-[-0.025em]"
                >
                  가는 길을 찾고 있어요
                </h2>
                <p className="mt-2 text-base text-[#6B7684]">
                  목적지까지 가는 버스 방향을 확인할게요.
                </p>
              </div>
            ) : recommended ? (
              <>
                <div>
                  <p className="text-base font-medium text-[#2165D6]">
                    {destination.name}까지
                  </p>
                </div>

                <div className="mt-2 text-left">
                  <p className="text-[2.55rem] font-bold leading-[1.18] tracking-[-0.035em] text-[#191F28]">
                    {tracking && alertPhase === 'depart' ? (
                      '출발 알림을 보냈어요'
                    ) : (departureOffset ?? 0) <= 0 ? (
                      <>
                        <span className="text-[#2165D6]">지금</span> 출발하면
                        돼요
                      </>
                    ) : (
                      <>
                        <span className="text-[#2165D6]">
                          {Math.max(0, Math.ceil(departureOffset ?? 0))}분 뒤
                        </span>{' '}
                        출발하면 돼요
                      </>
                    )}
                  </p>
                  <p className="mt-2 text-lg font-medium text-[#4E5968]">
                    {alertPlan
                      ? formatClock(0, alertPlan.departAt)
                      : formatClock(departureOffset ?? 0, clockNow)}{' '}
                    출발
                  </p>
                </div>

                <div className="mt-7 divide-y divide-[#E5E8EB] rounded-[1.5rem] bg-[#F2F4F6] px-4">
                  <div className="flex min-h-20 items-center gap-3 py-4">
                    <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-[#E8F3FF] text-[#2165D6]">
                      <BusFront aria-hidden="true" className="size-6" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2
                        id="recommendation-title"
                        className="text-xl font-bold tracking-[-0.025em]"
                      >
                        {recommended.route}번 저상버스
                      </h2>
                      <p className="mt-0.5 font-semibold text-[#4E5968]">
                        {trip.direction} · {Math.ceil(recommended.etaMinutes)}분
                        뒤
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-[#E8F8F0] px-2.5 py-1 text-xs font-semibold text-[#18794E]">
                      {dataMode === 'live' ? '저상 확인' : '저상 예시'}
                    </span>
                  </div>

                  <div className="py-4">
                    <div className="grid grid-cols-[1.5rem_1fr] gap-x-3 gap-y-4">
                      <span
                        aria-hidden="true"
                        className="mt-1 size-3 rounded-full border-[3px] border-[#2165D6] bg-white"
                      />
                      <div>
                        <p className="text-sm font-medium text-[#6B7684]">
                          타는 곳
                        </p>
                        <p className="mt-0.5 text-lg font-semibold">
                          {trip.boardingStop.name}
                        </p>
                      </div>
                      <MapPin
                        aria-hidden="true"
                        className="-ml-1 size-5 text-[#E5484D]"
                      />
                      <div>
                        <p className="text-sm font-medium text-[#6B7684]">
                          내리는 곳
                        </p>
                        <p className="mt-0.5 text-lg font-semibold">
                          {trip.alightingStop.name}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between rounded-xl bg-white px-4 py-3">
                      <div className="flex items-center gap-2 text-[#4E5968]">
                        <Clock3 aria-hidden="true" className="size-5" />
                        <span className="font-medium">준비 시작</span>
                      </div>
                      <p className="font-semibold tabular-nums">
                        {(prepOffset ?? 0) <= 0
                          ? '지금'
                          : formatClock(prepOffset ?? 0, clockNow)}
                      </p>
                    </div>
                  </div>
                </div>

                {tracking ? (
                  <div className="mt-6 rounded-2xl bg-[#E8F3FF] p-4">
                    <p className="flex items-center justify-center gap-2 text-lg font-bold text-[#1B64DA]">
                      <Check aria-hidden="true" className="size-6" />
                      {alertPhase === 'depart'
                        ? '출발할 시간이에요'
                        : alertPhase === 'prepare'
                          ? '준비할 시간이에요'
                          : '출발 알림이 켜졌어요'}
                    </p>
                    <Button
                      variant="outline"
                      className="mt-3 h-12 w-full rounded-xl border-0 bg-white font-bold text-[#1B64DA] hover:bg-[#DDEBFF]"
                      onClick={() => {
                        setTracking(false);
                        setStatusMessage('출발 알림을 껐어요.');
                      }}
                    >
                      알림 끄기
                    </Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => void startAlerts()}
                    className="mt-6 h-16 w-full rounded-2xl bg-[#2165D6] text-lg font-semibold text-white hover:bg-[#1B64DA]"
                  >
                    <BellRing aria-hidden="true" className="size-6" />
                    출발 알림 켜기
                  </Button>
                )}

                <div className="mt-3">
                  <Button
                    variant="outline"
                    className="h-14 w-full rounded-2xl border-0 bg-[#F2F4F6] text-base font-semibold text-[#333D4B] hover:bg-[#E5E8EB]"
                    onClick={() => announce(recommendationText)}
                  >
                    <Volume2 aria-hidden="true" className="size-5" />
                    안내 듣기
                  </Button>
                </div>

                <details className="mt-5 border-t border-[#E5E8EB]">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-1 text-sm font-semibold text-[#6B7684] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]">
                    시간 계산 보기
                    <ChevronDown aria-hidden="true" className="size-5" />
                  </summary>
                  <div className="pb-4 pt-1">
                    <p className="flex gap-2 text-sm font-medium leading-6 text-[#4E5968]">
                      <ShieldCheck
                        aria-hidden="true"
                        className="mt-0.5 size-5 shrink-0 text-[#2165D6]"
                      />
                      <span>
                        준비 {settings.preparationMinutes}분, 정류장까지{' '}
                        {travelMinutes}분, 여유 {settings.safetyMinutes}분을
                        모두 반영했어요.
                        {excluded.length > 0 &&
                          ' 더 빠른 버스는 시간이 부족해 제외했어요.'}
                        {' 정류장 시설 정보는 아직 확인하지 못했어요.'}
                      </span>
                    </p>
                    {dataMode === 'demo' && (
                      <Button
                        variant="outline"
                        className="mt-3 h-12 w-full rounded-xl border-0 bg-[#F2F4F6] font-bold text-[#4E5968]"
                        onClick={simulateArrivalChange}
                      >
                        <RefreshCw aria-hidden="true" />
                        도착시간 변동 시연
                      </Button>
                    )}
                  </div>
                </details>
              </>
            ) : (
              <div className="py-6 text-left">
                <h2
                  id="recommendation-title"
                  className="text-[2rem] font-bold leading-tight tracking-[-0.03em]"
                >
                  {dataMode === 'unavailable' || feedStale
                    ? '경로는 찾았어요'
                    : busesBusy
                      ? '도착 정보를 확인하고 있어요'
                      : '탈 수 있는 저상버스가 아직 없어요'}
                </h2>
                <p className="mt-2 text-lg leading-7 text-[#6B7684]">
                  {dataMode === 'unavailable' || feedStale
                    ? '저상버스 도착 정보가 확인되지 않아 아무 버스나 추천하지 않을게요.'
                    : '다음 도착 정보를 다시 확인하거나 이동 시간을 바꿔보세요.'}
                </p>
                <div className="mt-6 rounded-2xl bg-[#F2F4F6] p-4">
                  <p className="text-lg font-semibold">
                    {trip.route}번 · {trip.direction}
                  </p>
                  <p className="mt-1 text-sm font-medium leading-6 text-[#6B7684]">
                    {trip.boardingStop.name}에서 타고 {trip.alightingStop.name}
                    에서 내려요
                  </p>
                </div>
                <Button
                  className="mt-5 h-14 w-full rounded-2xl bg-[#2165D6] text-base font-semibold text-white hover:bg-[#1B64DA]"
                  onClick={() =>
                    dataMode === 'unavailable' || feedStale
                      ? setOrigin({ ...origin })
                      : setSettingsOpen(true)
                  }
                >
                  {dataMode === 'unavailable' || feedStale ? (
                    <RefreshCw aria-hidden="true" />
                  ) : (
                    <Settings2 aria-hidden="true" />
                  )}
                  {dataMode === 'unavailable' || feedStale
                    ? '다시 확인하기'
                    : '내 시간 바꾸기'}
                </Button>
              </div>
            )}
          </article>
          {alternativeTrips.length > 0 && (
            <details className="mt-4">
              <summary className="flex min-h-14 cursor-pointer items-center text-sm font-semibold text-[#4E5968]">
                다른 버스 경로 보기
              </summary>
              <div className="grid gap-2">
                {alternativeTrips.map((candidate) => (
                  <button
                    key={candidate.id}
                    className="min-h-16 rounded-xl bg-[#F2F4F6] p-4 text-left"
                    onClick={() => {
                      setTracking(false);
                      setBuses([]);
                      setTrip(candidate);
                      setAlternativeTrips((current) => [
                        ...current.filter((item) => item.id !== candidate.id),
                        ...(trip ? [trip] : []),
                      ]);
                      setSelectedStop({
                        id: candidate.boardingStop.id,
                        name: candidate.boardingStop.name,
                        direction: candidate.direction,
                        route: candidate.route,
                        cityCode: candidate.boardingStop.cityCode,
                      });
                    }}
                  >
                    <span className="block font-semibold">
                      {candidate.route}번 · {candidate.direction}
                    </span>
                    <span className="text-sm text-[#4E5968]">
                      {candidate.boardingStop.name}에서 탑승 · 약{' '}
                      {candidate.totalMinutes}분
                    </span>
                  </button>
                ))}
              </div>
            </details>
          )}
          {trip?.landingUrl && (
            <a
              href={trip.landingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 flex min-h-14 items-center justify-center gap-2 rounded-xl bg-[#F2F4F6] px-4 font-semibold text-[#333D4B]"
            >
              지도에서 전체 경로 보기{' '}
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          )}
          {notice && (
            <div
              className="mt-4 rounded-xl bg-[#F2F4F6] p-4 text-sm leading-6 text-[#4E5968]"
              role="note"
            >
              <p>{notice}</p>
              <button
                className="mt-2 min-h-11 font-semibold text-[#1B64DA]"
                onClick={() => setNotice(null)}
              >
                닫기
              </button>
            </div>
          )}

          {recommended && (
            <p className="mx-auto mt-5 max-w-sm text-center text-sm font-medium leading-5 text-[#647184]">
              버스 도착 시간은 운행 상황에 따라 바뀔 수 있어요.
            </p>
          )}
        </section>
      </div>

      <Dialog
        open={assistantOpen}
        onOpenChange={(open) => {
          setAssistantOpen(open);
          if (!open) {
            assistantRequestRef.current?.abort();
            voiceDraftRef.current = null;
            voiceCandidatesRef.current = [];
            if (recognitionRef.current || voicePressActiveRef.current) {
              cancelListening();
            }
            if (assistantCloseTimerRef.current !== null) {
              window.clearTimeout(assistantCloseTimerRef.current);
              assistantCloseTimerRef.current = null;
            }
          }
        }}
      >
        <DialogContent className="h-[min(36rem,100svh)] grid-rows-[minmax(0,1fr)_9rem_minmax(0,1fr)_3rem] gap-3 overflow-hidden px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-8 text-center sm:max-w-sm">
          <DialogHeader className="min-h-0 items-center gap-2 pr-0">
            <DialogTitle className="w-full shrink-0 px-9 text-2xl font-bold leading-8 tracking-[-0.02em]">
              {listening
                ? '듣고 있어요'
                : assistantBusy
                  ? '경로를 찾고 있어요'
                  : assistantInput
                    ? '이렇게 들었어요'
                    : '어디로 갈까요?'}
            </DialogTitle>
            <DialogDescription
              className="min-h-0 w-full overflow-y-auto break-words text-base leading-6"
              aria-live="polite"
              aria-atomic="true"
            >
              {listening
                ? tapToTalk
                  ? '다시 누르면 적용해요. 최대 15초까지 들을게요.'
                  : '손을 떼면 적용해요. 최대 15초까지 들을게요.'
                : assistantBusy
                  ? '말씀하신 장소를 확인하고 있어요.'
                  : assistantReply}
            </DialogDescription>
          </DialogHeader>

          <div className="flex h-36 items-center justify-center">
            <button
              type="button"
              onPointerDown={beginVoicePointer}
              onPointerUp={endVoicePointer}
              onPointerCancel={cancelVoicePointer}
              onKeyDown={handleVoiceKeyDown}
              onKeyUp={handleVoiceKeyUp}
              onClick={handleVoiceClick}
              onContextMenu={(event) => event.preventDefault()}
              disabled={assistantBusy}
              className={
                'relative grid size-28 touch-none select-none place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2165D6] disabled:cursor-wait ' +
                (listening
                  ? 'bg-[#2165D6] text-white shadow-[0_0_0_12px_#E8F3FF]'
                  : assistantBusy
                    ? 'bg-[#E8F3FF] text-[#2165D6]'
                    : 'bg-[#F2F4F6] text-[#2165D6] hover:bg-[#E8F3FF]')
              }
              aria-label={
                listening
                  ? '음성 인식 중. 손을 떼거나 다시 누르면 경로를 적용합니다'
                  : assistantBusy
                    ? '경로 확인 중'
                    : '누르고 있는 동안 말하기. 최대 15초'
              }
              aria-pressed={listening}
            >
              {assistantBusy ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-11 animate-spin"
                />
              ) : (
                <Mic
                  aria-hidden="true"
                  className={'size-11 ' + (listening ? 'animate-pulse' : '')}
                />
              )}
              {listening && (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 animate-ping rounded-full border-2 border-[#2165D6] opacity-20"
                />
              )}
            </button>
          </div>

          <div
            className="min-h-0 overflow-y-auto overscroll-contain break-words"
            aria-live={editingVoiceText ? 'off' : 'polite'}
            aria-atomic="true"
          >
            {editingVoiceText ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAssistant(assistantInput);
                }}
              >
                <label htmlFor="voice-text" className="sr-only">
                  말한 내용 수정
                </label>
                <textarea
                  id="voice-text"
                  value={assistantInput}
                  maxLength={300}
                  onChange={(event) => setAssistantInput(event.target.value)}
                  className="min-h-16 w-full resize-none rounded-xl bg-[#F2F4F6] px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-[#2165D6]"
                  placeholder="서울역에서 강남역까지"
                />
                <button
                  type="submit"
                  disabled={assistantBusy || !assistantInput.trim()}
                  className="min-h-11 w-full rounded-xl bg-[#2165D6] text-white disabled:opacity-50"
                >
                  이 내용으로 찾기
                </button>
              </form>
            ) : assistantInput ? (
              <p className="rounded-2xl bg-[#F2F4F6] px-4 py-3 text-lg font-semibold leading-7 text-[#333D4B]">
                “{assistantInput}”
              </p>
            ) : (
              <p className="text-sm font-medium text-[#647184]">
                예: 현재 위치에서 서울역까지 · 최대 15초
              </p>
            )}
            {!editingVoiceText && voiceModeNotice && (
              <p className="mt-2 text-xs text-[#647184]">{voiceModeNotice}</p>
            )}
          </div>
          <div className="flex h-12 gap-2">
            <button
              type="button"
              disabled={listening || assistantBusy}
              className={
                'min-h-12 flex-1 rounded-xl text-sm font-semibold text-[#1B64DA]' +
                (listening || assistantBusy ? ' invisible' : '')
              }
              onClick={() => setTapToTalk((value) => !value)}
            >
              {tapToTalk
                ? '길게 누르기로 바꾸기'
                : '한 번 눌러 말하기로 바꾸기'}
            </button>
            <button
              type="button"
              disabled={listening || assistantBusy}
              className={
                'min-h-12 rounded-xl px-3 text-sm font-semibold text-[#1B64DA]' +
                (listening || assistantBusy ? ' invisible' : '')
              }
              onClick={() => {
                if (assistantCloseTimerRef.current !== null)
                  window.clearTimeout(assistantCloseTimerRef.current);
                setEditingVoiceText((value) => !value);
              }}
            >
              {editingVoiceText ? '수정 닫기' : '글로 입력'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={placePicker !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPlacePicker(null);
            locationRequestRef.current?.abort();
            locationRequestRef.current = null;
            setPlaceBusy(false);
            assistantRequestRef.current?.abort();
            voiceDraftRef.current = null;
            voiceCandidatesRef.current = [];
          }
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
          aria-busy={placeBusy}
        >
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">
              {placePicker === 'origin'
                ? '어디서 출발하나요?'
                : '어디로 갈까요?'}
            </DialogTitle>
            <DialogDescription>
              장소 이름이나 주소를 입력해 주세요.
            </DialogDescription>
          </DialogHeader>

          {placePicker === 'origin' && (
            <Button
              type="button"
              className="h-14 w-full rounded-xl bg-[#2165D6] font-semibold text-white hover:bg-[#1B64DA]"
              onClick={useCurrentLocation}
              disabled={placeBusy}
            >
              {placeBusy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <LocateFixed aria-hidden="true" />
              )}
              현재 위치에서 출발
            </Button>
          )}

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void searchPlaces();
            }}
          >
            <label htmlFor="place-search" className="sr-only">
              장소 검색
            </label>
            <input
              id="place-search"
              value={placeQuery}
              onChange={(event) => setPlaceQuery(event.target.value)}
              placeholder="예: 홍대입구역"
              className="min-h-14 min-w-0 flex-1 rounded-xl border-0 bg-[#F2F4F6] px-4 text-base placeholder:text-[#647184] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
              autoComplete="off"
            />
            <Button
              type="submit"
              size="icon-lg"
              className="size-14 shrink-0 rounded-xl bg-[#2165D6] text-white hover:bg-[#1B64DA]"
              disabled={placeBusy || !placeQuery.trim()}
              aria-label="검색"
            >
              {placeBusy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <Search aria-hidden="true" />
              )}
            </Button>
          </form>

          <output
            aria-live="polite"
            aria-atomic="true"
            className="block px-1 text-sm leading-5 text-[#6B7684]"
          >
            {placeMessage}
          </output>
          {voiceChoiceActive && (
            <button
              type="button"
              className="min-h-12 rounded-xl bg-[#E8F3FF] px-4 text-sm font-semibold text-[#2165D6]"
              onClick={() => {
                setPlacePicker(null);
                const names = voiceCandidatesRef.current
                  .slice(0, 3)
                  .map(
                    (place, index) =>
                      `${index + 1}번 ${place.name}, ${place.address}`,
                  )
                  .join('. ');
                setAssistantReply(names + '. 번호나 장소 이름을 말해 주세요.');
                announce(names + '. 번호나 장소 이름을 말해 주세요.');
                setAssistantOpen(true);
              }}
            >
              말로 선택·다시 입력
            </button>
          )}

          <ul className="divide-y divide-[#E5E8EB]" aria-label="장소 검색 결과">
            {placeResults.map((place, index) => {
              const selected =
                placePicker === 'origin'
                  ? origin.id === place.id
                  : destination?.id === place.id;
              const sameAsOtherEnd =
                !voiceChoiceActive &&
                placePicker === 'destination' &&
                origin.id === place.id;
              return (
                <li key={place.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={
                      index +
                      1 +
                      '번, ' +
                      place.name +
                      ', ' +
                      place.address +
                      (selected ? ', 현재 선택됨' : '')
                    }
                    onClick={() => selectPlace(place)}
                    disabled={sameAsOtherEnd}
                    className={
                      'flex min-h-[4.5rem] w-full items-center gap-3 rounded-xl px-2 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6] ' +
                      (selected
                        ? 'bg-[#E8F3FF]'
                        : 'bg-white hover:bg-[#F9FAFB] disabled:opacity-40')
                    }
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#F2F4F6] text-[#2165D6]">
                      <MapPin aria-hidden="true" className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        {voiceChoiceActive ? index + 1 + '. ' : ''}
                        {place.name}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-[#6B7684]">
                        {sameAsOtherEnd
                          ? '출발지와 같은 곳이에요'
                          : place.address}
                      </span>
                    </span>
                    {selected && (
                      <span className="shrink-0 text-[#2165D6]">
                        <Check aria-hidden="true" className="size-6" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {placeResults.length === 0 && (
              <li className="rounded-xl bg-[#F2F4F6] p-5 text-center text-sm font-medium text-[#4E5968]">
                다른 장소 이름이나 주소로 검색해 보세요.
              </li>
            )}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[90dvh] gap-6 overflow-y-auto px-6 pb-8 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">
              이동 시간 설정
            </DialogTitle>
            <DialogDescription>
              평소 걸리는 시간을 알려주세요.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-7 pb-1">
            <p className="text-sm leading-5 text-[#647184]">
              음성은 브라우저에서 글로 바꿔요. AI 문장 해석이 연결되면 말한 글이
              OpenAI로 전송돼요. 앱에서 녹음 파일을 별도로 저장하지 않아요.
            </p>
            <div className="space-y-3">
              <div className="flex min-h-14 items-center justify-between gap-3 px-1 text-sm font-semibold">
                경로에 맞춰 이동 시간 계산
                <Switch
                  checked={settings.automaticTravelTime}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({
                      ...current,
                      automaticTravelTime: checked,
                    }))
                  }
                  aria-label="경로에 맞춰 이동 시간 자동 계산"
                />
              </div>
              {settings.automaticTravelTime && (
                <div className="px-1">
                  <label
                    htmlFor="travel-pace"
                    className="text-sm font-semibold"
                  >
                    내 이동 속도
                  </label>
                  <select
                    id="travel-pace"
                    value={settings.travelMultiplier}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        travelMultiplier: Number(event.target.value),
                      }))
                    }
                    className="mt-2 min-h-12 w-full rounded-xl bg-[#F2F4F6] px-3"
                  >
                    <option value={1}>보통 · 지도 예상 시간</option>
                    <option value={1.5}>천천히 · 1.5배</option>
                    <option value={2}>더 천천히 · 2배</option>
                  </select>
                  <p className="mt-2 text-sm leading-6 text-[#4E5968]">
                    경로의 도보 시간을 내 속도에 맞춰 조정해요. 계단이나
                    경사로는 아직 반영하지 못해요.
                  </p>
                </div>
              )}
              <TimeSetting
                label="준비 시간"
                value={settings.preparationMinutes}
                min={0}
                max={30}
                description="외출 준비에 걸리는 시간"
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    preparationMinutes: value,
                  }))
                }
              />
              <TimeSetting
                label="정류장까지"
                value={travelMinutes}
                min={1}
                max={60}
                description={
                  settings.automaticTravelTime
                    ? '직접 바꾸면 이 시간을 사용할게요'
                    : '정류장까지 직접 정한 이동 시간'
                }
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    travelMinutes: value,
                    automaticTravelTime: false,
                  }))
                }
              />
              <TimeSetting
                label="여유 시간"
                value={settings.safetyMinutes}
                min={1}
                max={15}
                description="신호 대기 등을 위한 추가 시간"
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    safetyMinutes: value,
                  }))
                }
              />
            </div>

            <div className="rounded-2xl bg-[#F7F8FA] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <label htmlFor="voice-choice" className="font-semibold">
                    안내 음성
                  </label>
                  <p className="mt-0.5 text-sm font-normal text-[#6B7684]">
                    기기의 한국어 음성을 사용해요
                  </p>
                </div>
                <Volume2
                  aria-hidden="true"
                  className="mt-1 size-5 text-[#2165D6]"
                />
              </div>
              <select
                id="voice-choice"
                value={settings.voiceURI}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    voiceURI: event.target.value,
                  }))
                }
                className="mt-3 min-h-14 w-full rounded-xl border-0 bg-[#F2F4F6] px-3 text-base font-semibold"
              >
                <option value="">자동 · 기기 추천 음성</option>
                {koreanVoiceOptions.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name}
                  </option>
                ))}
              </select>
              <fieldset className="mt-4">
                <legend className="text-sm font-semibold">읽는 속도</legend>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[
                    { label: '느리게', value: 0.8 },
                    { label: '편안하게', value: 0.88 },
                    { label: '보통', value: 0.98 },
                  ].map((option) => {
                    const selected =
                      Math.abs(settings.voiceRate - option.value) < 0.03;
                    return (
                      <button
                        key={option.label}
                        type="button"
                        aria-pressed={selected}
                        className={
                          'min-h-12 rounded-xl border-0 px-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6] ' +
                          (selected
                            ? 'bg-[#2165D6] text-white'
                            : 'bg-[#F2F4F6] text-[#4E5968]')
                        }
                        onClick={() =>
                          setSettings((current) => ({
                            ...current,
                            voiceRate: option.value,
                          }))
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <Button
                type="button"
                variant="outline"
                className="mt-4 h-12 w-full rounded-xl border-0 bg-[#F2F4F6] font-semibold text-[#333D4B]"
                onClick={() =>
                  announce(
                    '안녕하세요. 서두르지 않아도 괜찮아요. 출발할 시간을 편안하게 알려드릴게요.',
                  )
                }
              >
                <Volume2 aria-hidden="true" />
                미리 듣기
              </Button>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="voice-alerts"
                className="flex min-h-16 cursor-pointer items-center justify-between gap-4 rounded-2xl bg-[#F7F8FA] px-4"
              >
                <span className="font-semibold">음성으로 알림</span>
                <Switch
                  id="voice-alerts"
                  checked={settings.voiceAlerts}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({
                      ...current,
                      voiceAlerts: checked,
                    }))
                  }
                  aria-label="음성 알림"
                />
              </label>
              <label
                htmlFor="vibration-alerts"
                className="flex min-h-16 cursor-pointer items-center justify-between gap-4 rounded-2xl bg-[#F7F8FA] px-4"
              >
                <span className="font-semibold">진동으로 알림</span>
                <Switch
                  id="vibration-alerts"
                  checked={settings.vibrationAlerts}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({
                      ...current,
                      vibrationAlerts: checked,
                    }))
                  }
                  aria-label="진동 알림"
                />
              </label>
            </div>

            <div className="grid gap-3">
              <Button
                variant="outline"
                className="h-14 w-full rounded-xl border-0 bg-[#F2F4F6] font-semibold text-[#333D4B]"
                onClick={() => void installApp()}
              >
                <Download aria-hidden="true" />
                앱 설치하기
              </Button>
              <Button
                variant="outline"
                className="h-14 w-full rounded-xl border-0 bg-[#F2F4F6] font-semibold text-[#333D4B]"
                onClick={() => {
                  setSettingsOpen(false);
                  setHistoryOpen(true);
                }}
              >
                <History aria-hidden="true" />
                이동 결과 남기기
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold">
              이번 이동은 어땠나요?
            </DialogTitle>
            <DialogDescription>
              다음 출발 시간을 더 잘 맞춰드릴게요.
            </DialogDescription>
          </DialogHeader>
          {feedbackComplete ? (
            <div className="rounded-2xl bg-[#E8F8F0] p-5 text-center">
              <Check
                aria-hidden="true"
                className="mx-auto size-7 text-[#18794E]"
              />
              <p className="mt-2 font-bold text-[#18794E]">
                다음 추천에 반영했어요
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              <Button
                variant="outline"
                className="h-14 justify-start rounded-xl border-0 bg-[#F2F4F6] px-4 font-semibold"
                onClick={() => submitFeedback('comfortable')}
              >
                여유 있었어요
              </Button>
              <Button
                variant="outline"
                className="h-14 justify-start rounded-xl border-0 bg-[#F2F4F6] px-4 font-semibold"
                onClick={() => submitFeedback('rushed')}
              >
                조금 급했어요
              </Button>
              <Button
                variant="outline"
                className="h-14 justify-start rounded-xl border-0 bg-[#F2F4F6] px-4 font-semibold"
                onClick={() => submitFeedback('missed')}
              >
                버스를 놓쳤어요
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function TimeSetting({
  label,
  value,
  min,
  max,
  description,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  description: string;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="min-w-0 rounded-2xl bg-[#F7F8FA] p-4">
      <legend className="font-semibold">{label}</legend>
      <p className="mt-0.5 text-sm font-normal text-[#6B7684]">{description}</p>
      <div className="mt-3 grid grid-cols-[3.5rem_1fr_3.5rem] items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="grid size-14 place-items-center rounded-full bg-white text-3xl font-medium leading-none text-[#333D4B] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
          aria-label={label + ' 1분 줄이기'}
        >
          −
        </button>
        <output
          className="text-center text-2xl font-bold tabular-nums text-[#191F28]"
          aria-live="polite"
          aria-label={label + ' ' + value + '분'}
        >
          {value}분
        </output>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="grid size-14 place-items-center rounded-full bg-white text-3xl font-medium leading-none text-[#333D4B] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2165D6]"
          aria-label={label + ' 1분 늘리기'}
        >
          +
        </button>
      </div>
    </fieldset>
  );
}
