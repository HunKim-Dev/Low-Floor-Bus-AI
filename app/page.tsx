import BusApp from './BusApp';
import { cloudflareSettings } from '@/lib/cloudflare-ai';
import { geminiSpeechSettings } from '@/lib/text-to-speech';

// Credentials are read on the server at runtime; only capability is sent down.
export const dynamic = 'force-dynamic';

export default function Home() {
  const ai = cloudflareSettings();
  return (
    <BusApp
      cloudSpeechEnabled={ai.speechEnabled}
      cloudTtsEnabled={geminiSpeechSettings().enabled}
    />
  );
}
