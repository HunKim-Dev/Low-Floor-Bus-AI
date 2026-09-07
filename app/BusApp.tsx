'use client';

import {
  BellRing,
  BrainCircuit,
  BusFront,
  Calculator,
  Check,
  ChevronDown,
  Clock3,
  Database,
  Download,
  History,
  LoaderCircle,
  MapPin,
  Mic,
  Navigation,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Volume2,
  Waves,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

type BusCandidate = {
  id: string;
  route: string;
  etaMinutes: number;
  stopsAway: number;
  lowFloor: boolean;
  congestion: '여유' | '보통' | '혼잡' | '정보 없음';
};

type Settings = {
  preparationMinutes: number;
  travelMinutes: number;
  safetyMinutes: number;
  voiceAlerts: boolean;
  vibrationAlerts: boolean;
};

type Stop = {
  id: string;
  name: string;
  direction: string;
  route: string;
};

type RecognitionEventLike = {
  results: ArrayLike<{ 0: { transcript: string } }>;
};

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
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
  intent: 'clarify_stop' | 'recommend_accessible_bus';
  changes: {
    stopId?: string;
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

const stops: Stop[] = [
  {
    id: 'demo-sinchon',
    name: '신촌로터리',
    direction: '홍대입구 방향',
    route: '271',
  },
  {
    id: 'demo-seoul',
    name: '서울역버스환승센터',
    direction: '만리동 방향',
    route: '701',
  },
  { id: 'demo-gangnam', name: '강남역', direction: '양재 방향', route: '3412' },
];

const defaultBuses: BusCandidate[] = [
  {
    id: 'general-1',
    route: '271',
    etaMinutes: 5,
    stopsAway: 2,
    lowFloor: false,
    congestion: '보통',
  },
  {
    id: 'low-1',
    route: '271',
    etaMinutes: 8,
    stopsAway: 3,
    lowFloor: true,
    congestion: '여유',
  },
  {
    id: 'low-2',
    route: '271',
    etaMinutes: 18,
    stopsAway: 4,
    lowFloor: true,
    congestion: '여유',
  },
  {
    id: 'low-3',
    route: '271',
    etaMinutes: 30,
    stopsAway: 8,
    lowFloor: true,
    congestion: '정보 없음',
  },
];

const defaultSettings: Settings = {
  preparationMinutes: 3,
  travelMinutes: 7,
  safetyMinutes: 2,
  voiceAlerts: true,
  vibrationAlerts: true,
};

function formatClock(minutesFromNow: number, baseTime: number | null) {
  if (baseTime === null) return '계산 중';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(baseTime + Math.max(0, minutesFromNow) * 60_000));
}

function getRecommendation(buses: BusCandidate[], settings: Settings) {
  const requiredLead =
    settings.preparationMinutes +
    settings.travelMinutes +
    settings.safetyMinutes;
  const lowFloorBuses = buses
    .filter((bus) => bus.lowFloor)
    .sort((a, b) => a.etaMinutes - b.etaMinutes);
  const recommended =
    lowFloorBuses.find((bus) => bus.etaMinutes >= requiredLead) ?? null;
  const excluded = lowFloorBuses.filter((bus) => bus.etaMinutes < requiredLead);
  return { recommended, excluded, requiredLead };
}

export default function BusApp() {
  const [selectedStop, setSelectedStop] = useState(stops[0]);
  const [buses, setBuses] = useState<BusCandidate[]>(defaultBuses);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [dataMode, setDataMode] = useState<'demo' | 'live'>('demo');
  const [tracking, setTracking] = useState(false);
  const [listening, setListening] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    '시연 데이터로 추천을 준비했어요.',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stopsOpen, setStopsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(
    null,
  );
  const [feedbackComplete, setFeedbackComplete] = useState(false);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantReply, setAssistantReply] = useState(
    '말로 요청하면 정류장과 이동 조건을 이해한 뒤 안전 계산을 실행해요.',
  );
  const [agentTrace, setAgentTrace] = useState<AgentTraceStep[]>([
    {
      label: '요청 이해',
      detail: '정류장·버스·이동 조건 파악',
      status: 'waiting',
    },
    { label: '정보 조회', detail: '저상버스 도착정보 확인', status: 'waiting' },
    {
      label: '안전 계산',
      detail: '준비 + 이동 + 여유시간 검증',
      status: 'waiting',
    },
    { label: '맞춤 안내', detail: '출발 시각과 이유 설명', status: 'waiting' },
  ]);

  const result = useMemo(
    () => getRecommendation(buses, settings),
    [buses, settings],
  );
  const recommended = result.recommended;
  const excluded = result.excluded;
  const requiredLead = result.requiredLead;
  const prepOffset = recommended ? recommended.etaMinutes - requiredLead : null;
  const departureOffset = recommended
    ? recommended.etaMinutes - settings.travelMinutes - settings.safetyMinutes
    : null;

  const recommendationText = recommended
    ? recommended.route +
      '번 저상버스는 약 ' +
      recommended.etaMinutes +
      '분 뒤 도착합니다. ' +
      Math.max(0, prepOffset ?? 0) +
      '분 뒤 준비를 시작하고 ' +
      Math.max(0, departureOffset ?? 0) +
      '분 뒤 출발하면 정류장에 ' +
      settings.safetyMinutes +
      '분 먼저 도착할 수 있어요.'
    : '현재 준비시간과 이동시간으로 여유 있게 탈 수 있는 저상버스를 찾지 못했어요.';

  const announce = useCallback(
    (message: string) => {
      if (!settings.voiceAlerts || typeof window === 'undefined') return;
      if (!('speechSynthesis' in window)) {
        setStatusMessage('이 브라우저에서는 음성 출력을 지원하지 않아요.');
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.lang = 'ko-KR';
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    },
    [settings.voiceAlerts],
  );

  const notify = useCallback(
    (title: string, body: string) => {
      announce(title + '. ' + body);
      if (settings.vibrationAlerts && 'vibrate' in navigator) {
        navigator.vibrate([180, 90, 180]);
      }
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icon.svg' });
      }
      setStatusMessage(title + ' — ' + body);
    },
    [announce, settings.vibrationAlerts],
  );

  const startAlerts = useCallback(async () => {
    if (!recommended) {
      setStatusMessage('알림을 시작할 수 있는 저상버스가 아직 없어요.');
      return { started: false, reason: 'no_recommendation' };
    }
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    setTracking(true);
    setStatusMessage(
      recommended.route + '번 버스의 준비·출발 알림을 시작했어요.',
    );
    announce('알림을 시작합니다. ' + recommendationText);
    return {
      started: true,
      route: recommended.route,
      preparationInMinutes: Math.max(0, prepOffset ?? 0),
      departureInMinutes: Math.max(0, departureOffset ?? 0),
    };
  }, [announce, departureOffset, prepOffset, recommendationText, recommended]);

  useEffect(() => {
    const initializationFrame = window.requestAnimationFrame(() => {
      setClockNow(Date.now());
      const saved = window.localStorage.getItem('bus-majung-settings');
      if (saved) {
        try {
          setSettings({ ...defaultSettings, ...JSON.parse(saved) });
        } catch {
          window.localStorage.removeItem('bus-majung-settings');
        }
      }
    });
    const clockTimer = window.setInterval(
      () => setClockNow(Date.now()),
      30_000,
    );
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js');
    }
    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleInstall);
    return () => {
      window.cancelAnimationFrame(initializationFrame);
      window.clearInterval(clockTimer);
      window.removeEventListener('beforeinstallprompt', handleInstall);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      'bus-majung-settings',
      JSON.stringify(settings),
    );
  }, [settings]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadBuses() {
      try {
        const requestUrl =
          '/api/buses?route=' +
          encodeURIComponent(selectedStop.route) +
          '&nodeId=' +
          encodeURIComponent(selectedStop.id);
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('bus fetch failed');
        const payload = (await response.json()) as {
          mode: 'demo' | 'live';
          buses: BusCandidate[];
        };
        setBuses(payload.buses);
        setDataMode(payload.mode);
        setStatusMessage(
          payload.mode === 'live'
            ? '실시간 버스 정보를 불러왔어요.'
            : '시연 데이터로 추천을 준비했어요.',
        );
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setBuses(
            defaultBuses.map((bus) => ({ ...bus, route: selectedStop.route })),
          );
          setDataMode('demo');
          setStatusMessage('실시간 연결이 어려워 시연 데이터로 전환했어요.');
        }
      }
    }
    void loadBuses();
    return () => controller.abort();
  }, [selectedStop]);

  useEffect(() => {
    if (!tracking || !recommended) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (prepOffset !== null && prepOffset > 0) {
      timers.push(
        setTimeout(
          () =>
            notify(
              '외출 준비를 시작하세요',
              recommended.route +
                '번 저상버스에 맞춰 ' +
                settings.preparationMinutes +
                '분 동안 준비할 시간이에요.',
            ),
          prepOffset * 60_000,
        ),
      );
    }
    if (departureOffset !== null && departureOffset > 0) {
      timers.push(
        setTimeout(
          () =>
            notify(
              '지금 출발하세요',
              selectedStop.name +
                ' 정류장까지 ' +
                settings.travelMinutes +
                '분으로 예상돼요.',
            ),
          departureOffset * 60_000,
        ),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [
    departureOffset,
    notify,
    prepOffset,
    recommended,
    selectedStop.name,
    settings.preparationMinutes,
    settings.travelMinutes,
    tracking,
  ]);

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
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          execute(input) {
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
            const nextResult = getRecommendation(buses, nextSettings);
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

  const runAssistant = async (message: string) => {
    const cleanMessage = message.trim();
    if (!cleanMessage || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantReply('요청을 이해하고 필요한 정보를 확인하고 있어요…');
    setStatusMessage('AI 도우미가 요청을 분석하고 있어요.');
    try {
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: cleanMessage,
          currentStop: selectedStop,
          availableStops: stops,
          settings,
        }),
      });
      const payload = (await response.json()) as AssistantResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? 'assistant request failed');

      if (payload.changes.stopId) {
        const nextStop = stops.find(
          (stop) => stop.id === payload.changes.stopId,
        );
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
          ? { travelMinutes: payload.changes.travelMinutes }
          : {}),
        ...(payload.changes.safetyMinutes !== undefined
          ? { safetyMinutes: payload.changes.safetyMinutes }
          : {}),
      }));
      setAgentTrace(payload.trace);
      setAssistantReply(payload.responseText);
      setStatusMessage(
        payload.needsClarification
          ? 'AI 도우미가 정류장 확인을 요청했어요.'
          : 'AI 도우미가 조건을 반영해 추천을 다시 계산했어요.',
      );
      setAssistantInput('');
      announce(
        payload.responseText +
          (payload.needsClarification ? '' : ' ' + recommendationText),
      );
    } catch {
      setAssistantReply(
        '잠시 연결이 불안정해요. 현재 화면의 추천은 계속 이용할 수 있어요.',
      );
      setStatusMessage('AI 도우미 연결이 어려워 기존 추천을 유지했어요.');
    } finally {
      setAssistantBusy(false);
    }
  };

  const startListening = () => {
    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setStatusMessage(
        '이 브라우저는 음성 질문을 지원하지 않아요. 추천 읽기 버튼을 이용해 주세요.',
      );
      announce(recommendationText);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'ko-KR';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';
      setAssistantInput(transcript);
      void runAssistant(transcript);
    };
    recognition.onerror = () =>
      setStatusMessage('음성을 알아듣지 못했어요. 다시 말해 주세요.');
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  };

  const simulateArrivalChange = () => {
    if (!recommended) return;
    setBuses((current) =>
      current.map((bus) =>
        bus.id === recommended.id
          ? { ...bus, etaMinutes: Math.max(1, bus.etaMinutes - 8) }
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
      setStatusMessage(
        '브라우저의 공유 메뉴에서 “홈 화면에 추가”를 선택하면 앱처럼 사용할 수 있어요.',
      );
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

  const listeningIconClass = listening
    ? 'grid size-11 place-items-center rounded-2xl animate-pulse bg-[#ffe6a9] text-[#7a4b00]'
    : 'grid size-11 place-items-center rounded-2xl bg-[#eaf1f8] text-[#234c7c]';

  return (
    <main className="min-h-dvh bg-[#e9eef4] text-[#10233f]">
      <div className="mx-auto min-h-dvh w-full max-w-[480px] bg-[#f7f9fb] shadow-[0_0_70px_rgba(15,35,63,0.14)]">
        <header className="bg-[#10233f] px-5 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="grid size-11 place-items-center rounded-2xl bg-[#c7f36b] text-[#10233f] shadow-[0_8px_24px_rgba(199,243,107,0.2)]">
                <BusFront
                  aria-hidden="true"
                  className="size-6"
                  strokeWidth={2.4}
                />
              </span>
              <div>
                <p className="text-[0.75rem] font-semibold tracking-[0.08em] text-[#a9bad0]">
                  이동을 내 속도에 맞게
                </p>
                <h1 className="text-xl font-black tracking-[-0.04em]">
                  버스마중
                </h1>
              </div>
            </div>
            <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm font-bold text-[#c7f36b]">
              {dataMode === 'live' ? '실시간' : '시연 데이터'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setStopsOpen(true)}
            className="mt-7 flex min-h-14 w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.08] px-4 text-left transition hover:bg-white/[0.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c7f36b]"
            aria-label={
              '이용 정류장 변경. 현재 ' +
              selectedStop.name +
              ', ' +
              selectedStop.direction
            }
          >
            <MapPin aria-hidden="true" className="size-5 text-[#c7f36b]" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-[#9fb1c8]">
                이용 정류장
              </span>
              <span className="block truncate text-base font-bold">
                {selectedStop.name} · {selectedStop.direction}
              </span>
            </span>
            <ChevronDown aria-hidden="true" className="size-5 text-[#9fb1c8]" />
          </button>
        </header>

        <section
          className="relative -mt-4 px-4 pb-36"
          aria-labelledby="recommendation-title"
        >
          <div
            aria-live="polite"
            className="mb-3 flex min-h-11 items-center gap-2 rounded-2xl border border-[#dce4ec] bg-white px-4 text-sm font-bold text-[#516985]"
          >
            <Waves
              aria-hidden="true"
              className="size-4 shrink-0 text-[#356415]"
            />
            <span>{statusMessage}</span>
          </div>

          <div className="rounded-[1.75rem] border border-[#dce4ec] bg-white p-5 shadow-[0_18px_40px_rgba(20,45,75,0.08)]">
            {recommended ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-2 flex items-center gap-2 text-sm font-bold text-[#356415]">
                      <Sparkles aria-hidden="true" className="size-4" />
                      가장 여유로운 선택
                    </div>
                    <h2
                      id="recommendation-title"
                      className="text-[1.9rem] font-black tracking-[-0.05em]"
                    >
                      {recommended.route}번 저상버스
                    </h2>
                    <p className="mt-1 font-semibold text-[#59708d]">
                      {recommended.stopsAway}정거장 전 · 약{' '}
                      {recommended.etaMinutes}분 뒤
                    </p>
                  </div>
                  <span className="grid size-16 shrink-0 place-items-center rounded-[1.35rem] bg-[#e8f9c6] text-[#356415]">
                    <BusFront
                      aria-hidden="true"
                      className="size-8"
                      strokeWidth={2.3}
                    />
                  </span>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-2.5">
                  <div className="rounded-2xl bg-[#f1f5f8] p-4">
                    <div className="flex items-center gap-1.5 text-sm font-bold text-[#59708d]">
                      <Clock3 aria-hidden="true" className="size-4" />
                      준비 시작
                    </div>
                    <p className="mt-2 text-2xl font-black tabular-nums">
                      {formatClock(prepOffset ?? 0, clockNow)}
                    </p>
                    <p className="mt-1 text-sm font-medium text-[#6f829a]">
                      {Math.max(0, prepOffset ?? 0)}분 뒤
                    </p>
                  </div>
                  <div className="rounded-2xl bg-[#10233f] p-4 text-white">
                    <div className="flex items-center gap-1.5 text-sm font-bold text-[#b8c7d9]">
                      <Navigation
                        aria-hidden="true"
                        className="size-4 text-[#c7f36b]"
                      />
                      출발
                    </div>
                    <p className="mt-2 text-2xl font-black tabular-nums">
                      {formatClock(departureOffset ?? 0, clockNow)}
                    </p>
                    <p className="mt-1 text-sm font-medium text-[#b8c7d9]">
                      {Math.max(0, departureOffset ?? 0)}분 뒤
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex gap-3 rounded-2xl border border-[#dce4ec] bg-[#fbfcfd] p-4">
                  <ShieldCheck
                    aria-hidden="true"
                    className="mt-0.5 size-5 shrink-0 text-[#356415]"
                  />
                  <p className="text-[0.95rem] font-medium leading-6 text-[#3f5570]">
                    {excluded.length > 0
                      ? excluded[0].etaMinutes +
                        '분 뒤 저상버스는 이동시간이 부족해 제외했어요. '
                      : '현재 조건에서 가장 빠르게 탈 수 있는 저상버스예요. '}
                    정류장에{' '}
                    <strong className="text-[#10233f]">
                      {settings.safetyMinutes}분 먼저
                    </strong>{' '}
                    도착하도록 계산했어요.
                  </p>
                </div>

                {tracking ? (
                  <div className="mt-5 rounded-2xl bg-[#e8f9c6] p-4">
                    <div className="flex items-center justify-between">
                      <p className="flex items-center gap-2 font-black text-[#274c12]">
                        <Check aria-hidden="true" className="size-5" />
                        알림 안내 중
                      </p>
                      <span className="text-sm font-bold text-[#4c702e]">
                        다음: 준비 시작
                      </span>
                    </div>
                    <Progress value={35} className="mt-3" />
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        className="h-11 rounded-xl border-[#afcf73] bg-white/70 font-bold"
                        onClick={() =>
                          notify('알림 미리보기', recommendationText)
                        }
                      >
                        <Volume2 aria-hidden="true" />
                        미리 듣기
                      </Button>
                      {dataMode === 'demo' && (
                        <Button
                          variant="outline"
                          className="h-11 rounded-xl border-[#afcf73] bg-white/70 font-bold"
                          onClick={simulateArrivalChange}
                        >
                          <RefreshCw aria-hidden="true" />
                          변동 시연
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <Button
                    onClick={() => void startAlerts()}
                    className="mt-5 h-14 w-full rounded-2xl bg-[#c7f36b] text-base font-black text-[#10233f] shadow-[0_10px_22px_rgba(139,185,53,0.2)] hover:bg-[#b8e75a]"
                  >
                    <BellRing aria-hidden="true" className="size-5" />
                    준비·출발 알림 시작
                  </Button>
                )}
              </>
            ) : (
              <div className="py-6 text-center">
                <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-[#f1f5f8] text-[#59708d]">
                  <BusFront aria-hidden="true" className="size-8" />
                </span>
                <h2
                  id="recommendation-title"
                  className="mt-4 text-xl font-black"
                >
                  다음 저상버스를 확인하고 있어요
                </h2>
                <p className="mt-2 text-[#59708d]">
                  현재 이동시간으로 여유 있게 탈 수 있는 차량이 아직 없어요.
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 overflow-hidden rounded-[1.5rem] border border-[#cfdbe7] bg-white">
            <div className="bg-[#10233f] p-4 text-white">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={listeningIconClass}>
                    {assistantBusy ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-5 animate-spin"
                      />
                    ) : (
                      <BrainCircuit aria-hidden="true" className="size-5" />
                    )}
                  </span>
                  <div>
                    <p className="font-black">
                      {listening
                        ? '듣고 있어요…'
                        : assistantBusy
                          ? 'AI가 판단 중이에요…'
                          : 'AI 이동 도우미'}
                    </p>
                    <p className="text-sm font-medium text-[#b8c7d9]">
                      말하거나 직접 입력해 보세요
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="size-11 rounded-2xl border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                  onClick={() =>
                    announce(assistantReply + ' ' + recommendationText)
                  }
                  aria-label="AI 안내 내용을 음성으로 듣기"
                >
                  <Volume2 aria-hidden="true" className="size-5" />
                </Button>
              </div>

              <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAssistant(assistantInput);
                }}
              >
                <label htmlFor="assistant-question" className="sr-only">
                  AI 이동 도우미에게 질문
                </label>
                <input
                  id="assistant-question"
                  value={assistantInput}
                  onChange={(event) => setAssistantInput(event.target.value)}
                  placeholder="예: 이동시간 12분으로 바꿔줘"
                  className="min-h-12 min-w-0 flex-1 rounded-2xl border border-white/15 bg-white px-4 text-base font-semibold text-[#10233f] placeholder:text-[#8091a6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c7f36b]"
                  maxLength={300}
                />
                <Button
                  type="button"
                  size="icon-lg"
                  className="size-12 shrink-0 rounded-2xl bg-white/10 text-white hover:bg-white/20"
                  onClick={startListening}
                  aria-label="음성으로 질문하기"
                  disabled={assistantBusy}
                >
                  <Mic aria-hidden="true" className="size-5" />
                </Button>
                <Button
                  type="submit"
                  size="icon-lg"
                  className="size-12 shrink-0 rounded-2xl bg-[#c7f36b] text-[#10233f] hover:bg-[#b8e75a]"
                  aria-label="AI 도우미에게 보내기"
                  disabled={assistantBusy || !assistantInput.trim()}
                >
                  <Send aria-hidden="true" className="size-5" />
                </Button>
              </form>
              <button
                type="button"
                className="mt-2 rounded-lg px-1 py-1 text-left text-xs font-bold text-[#c7f36b] underline-offset-4 hover:underline"
                onClick={() => {
                  setAssistantInput('강남역 3412번, 이동시간 12분으로 알려줘');
                  void runAssistant('강남역 3412번, 이동시간 12분으로 알려줘');
                }}
                disabled={assistantBusy}
              >
                시연 문장으로 바로 체험하기
              </button>
            </div>

            <div className="p-4">
              <p
                className="flex items-start gap-2 text-[0.95rem] font-semibold leading-6 text-[#3f5570]"
                aria-live="polite"
              >
                <Sparkles
                  aria-hidden="true"
                  className="mt-1 size-4 shrink-0 text-[#356415]"
                />
                <span>{assistantReply}</span>
              </p>
              <div
                className="mt-4 grid grid-cols-2 gap-2"
                aria-label="AI 판단 과정"
              >
                {agentTrace.map((step, index) => {
                  const StepIcon =
                    index === 0
                      ? BrainCircuit
                      : index === 1
                        ? Database
                        : index === 2
                          ? Calculator
                          : Sparkles;
                  const complete = step.status === 'complete';
                  const attention = step.status === 'attention';
                  return (
                    <div
                      key={step.label}
                      className={
                        'rounded-2xl border p-3 ' +
                        (complete
                          ? 'border-[#cce6a1] bg-[#f3fbdf]'
                          : attention
                            ? 'border-[#f1d58c] bg-[#fff8e6]'
                            : 'border-[#e0e7ee] bg-[#f7f9fb]')
                      }
                    >
                      <div className="flex items-center gap-2">
                        <StepIcon
                          aria-hidden="true"
                          className={
                            complete
                              ? 'size-4 text-[#356415]'
                              : 'size-4 text-[#71839a]'
                          }
                        />
                        <p className="text-sm font-black">{step.label}</p>
                      </div>
                      <p className="mt-1.5 text-xs font-semibold leading-5 text-[#667b93]">
                        {step.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs font-semibold leading-5 text-[#71839a]">
                AI는 요청 이해와 설명을 맡고, 시간은 실시간 데이터와 안전
                계산식으로 확정해요.
              </p>
            </div>
          </div>

          <p className="mx-auto mt-4 max-w-sm text-center text-xs font-medium leading-5 text-[#71839a]">
            도착정보는 예상값이며 실제 운행 상황에 따라 달라질 수 있어요. 무리한
            이동보다 안전을 우선해 주세요.
          </p>
        </section>

        <nav
          aria-label="주요 메뉴"
          className="fixed inset-x-0 bottom-0 z-20 mx-auto flex w-full max-w-[480px] items-center justify-around border-t border-[#dce4ec] bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl"
        >
          <button
            className="flex min-h-12 min-w-20 flex-col items-center justify-center gap-1 rounded-xl text-xs font-black text-[#10233f]"
            type="button"
          >
            <BusFront aria-hidden="true" className="size-5" />
            버스 추천
          </button>
          <button
            className="flex min-h-12 min-w-20 flex-col items-center justify-center gap-1 rounded-xl text-xs font-bold text-[#71839a]"
            type="button"
            onClick={() => setHistoryOpen(true)}
          >
            <History aria-hidden="true" className="size-5" />
            이동 기록
          </button>
          <button
            className="flex min-h-12 min-w-20 flex-col items-center justify-center gap-1 rounded-xl text-xs font-bold text-[#71839a]"
            type="button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 aria-hidden="true" className="size-5" />
            내 설정
          </button>
        </nav>
      </div>

      <Dialog open={stopsOpen} onOpenChange={setStopsOpen}>
        <DialogContent className="max-h-[80dvh] rounded-[1.75rem] p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-black">
              이용 정류장 선택
            </DialogTitle>
            <DialogDescription>
              자주 이용하는 정류장과 진행 방향을 선택하세요.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {stops.map((stop) => {
              const selected = selectedStop.id === stop.id;
              return (
                <button
                  key={stop.id}
                  type="button"
                  onClick={() => {
                    setSelectedStop(stop);
                    setTracking(false);
                    setStopsOpen(false);
                  }}
                  className={
                    'flex min-h-16 items-center gap-3 rounded-2xl border p-3 text-left ' +
                    (selected
                      ? 'border-[#10233f] bg-[#eef3f8]'
                      : 'border-[#dce4ec] bg-white')
                  }
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-[#e8f9c6] font-black text-[#356415]">
                    {stop.route}
                  </span>
                  <span className="flex-1">
                    <span className="block font-black">{stop.name}</span>
                    <span className="text-sm font-medium text-[#6f829a]">
                      {stop.direction}
                    </span>
                  </span>
                  {selected && <Check aria-hidden="true" className="size-5" />}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto rounded-[1.75rem] p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-black">
              내 이동 설정
            </DialogTitle>
            <DialogDescription>
              평소 이동에 필요한 시간을 알려주면 추천을 바로 다시 계산해요.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <TimeSetting
              label="외출 준비시간"
              value={settings.preparationMinutes}
              min={0}
              max={30}
              description="휠체어와 소지품을 준비하는 시간"
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  preparationMinutes: value,
                }))
              }
            />
            <TimeSetting
              label="정류장 이동시간"
              value={settings.travelMinutes}
              min={1}
              max={30}
              description="집이나 현재 위치에서 정류장까지"
              onChange={(value) =>
                setSettings((current) => ({ ...current, travelMinutes: value }))
              }
            />
            <TimeSetting
              label="안전 여유시간"
              value={settings.safetyMinutes}
              min={1}
              max={10}
              description="횡단보도와 승차 위치 이동을 위한 여유"
              onChange={(value) =>
                setSettings((current) => ({ ...current, safetyMinutes: value }))
              }
            />

            <div className="divide-y divide-[#e2e8ef] rounded-2xl border border-[#dce4ec]">
              <div className="flex min-h-14 items-center justify-between gap-4 px-4">
                <span className="font-bold">음성 알림</span>
                <Switch
                  checked={settings.voiceAlerts}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({
                      ...current,
                      voiceAlerts: checked,
                    }))
                  }
                  aria-label="음성 알림"
                />
              </div>
              <div className="flex min-h-14 items-center justify-between gap-4 px-4">
                <span className="font-bold">진동 알림</span>
                <Switch
                  checked={settings.vibrationAlerts}
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({
                      ...current,
                      vibrationAlerts: checked,
                    }))
                  }
                  aria-label="진동 알림"
                />
              </div>
            </div>

            <Button
              variant="outline"
              className="h-12 w-full rounded-2xl font-black"
              onClick={() => void installApp()}
            >
              <Download aria-hidden="true" />
              홈 화면에 앱으로 설치
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="rounded-[1.75rem] p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-black">
              이동 결과 기록
            </DialogTitle>
            <DialogDescription>
              실제 이동 결과를 알려주면 다음 추천의 여유시간을 조정해요.
            </DialogDescription>
          </DialogHeader>
          {feedbackComplete ? (
            <div className="rounded-2xl bg-[#e8f9c6] p-5 text-center">
              <Check
                aria-hidden="true"
                className="mx-auto size-7 text-[#356415]"
              />
              <p className="mt-2 font-black text-[#274c12]">
                다음 추천에 반영했어요
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              <Button
                variant="outline"
                className="h-12 justify-start rounded-2xl px-4"
                onClick={() => submitFeedback('comfortable')}
              >
                여유 있게 탑승했어요
              </Button>
              <Button
                variant="outline"
                className="h-12 justify-start rounded-2xl px-4"
                onClick={() => submitFeedback('rushed')}
              >
                조금 급하게 탑승했어요
              </Button>
              <Button
                variant="outline"
                className="h-12 justify-start rounded-2xl px-4"
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
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-black">{label}</p>
          <p className="mt-0.5 text-sm font-medium text-[#71839a]">
            {description}
          </p>
        </div>
        <strong className="shrink-0 text-lg tabular-nums">{value}분</strong>
      </div>
      <Slider
        className="mt-4 [&_[data-slot=slider-track]]:h-2 [&_[data-slot=slider-thumb]]:size-5"
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        aria-label={label}
      />
    </div>
  );
}
