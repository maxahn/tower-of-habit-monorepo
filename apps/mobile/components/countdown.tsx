import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '~/components/ui/text';

function computeRemaining(deadlineAt: string): number {
  return new Date(deadlineAt).getTime() - Date.now();
}

function formatSegments(ms: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { days, hours, minutes, seconds };
}

type Urgency = 'normal' | 'attention' | 'urgent';

function getUrgency(ms: number): Urgency {
  if (ms <= 0) return 'urgent';
  if (ms < 60 * 60 * 1000) return 'urgent';
  if (ms < 24 * 60 * 60 * 1000) return 'attention';
  return 'normal';
}

const URGENCY_STYLES: Record<Urgency, { container: string; text: string }> = {
  normal: { container: '', text: 'text-foreground' },
  attention: {
    container: 'bg-amber-50 border border-amber-200 rounded-lg p-3',
    text: 'text-amber-800',
  },
  urgent: { container: 'bg-red-50 border border-red-200 rounded-lg p-3', text: 'text-red-700' },
};

function Segment({ value, label, textClass }: { value: number; label: string; textClass: string }) {
  return (
    <View className="items-center">
      <Text className={`text-2xl font-bold tabular-nums ${textClass}`}>
        {String(value).padStart(2, '0')}
      </Text>
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

export function Countdown({ deadlineAt }: { deadlineAt: string }) {
  const [remaining, setRemaining] = useState(() => computeRemaining(deadlineAt));

  useEffect(() => {
    setRemaining(computeRemaining(deadlineAt));
    const id = setInterval(() => {
      setRemaining(computeRemaining(deadlineAt));
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineAt]);

  if (remaining <= 0) {
    return (
      <View className="items-center rounded-lg border border-muted bg-muted/50 p-3">
        <Text className="text-sm font-medium text-muted-foreground">
          Past deadline — evaluating…
        </Text>
      </View>
    );
  }

  const urgency = getUrgency(remaining);
  const style = URGENCY_STYLES[urgency];
  const { days, hours, minutes, seconds } = formatSegments(remaining);

  return (
    <View className={`items-center ${style.container}`}>
      <View className="flex-row items-baseline gap-3">
        {days > 0 && (
          <>
            <Segment value={days} label="days" textClass={style.text} />
            <Text className={`text-xl font-bold ${style.text}`}>:</Text>
          </>
        )}
        <Segment value={hours} label="hrs" textClass={style.text} />
        <Text className={`text-xl font-bold ${style.text}`}>:</Text>
        <Segment value={minutes} label="min" textClass={style.text} />
        <Text className={`text-xl font-bold ${style.text}`}>:</Text>
        <Segment value={seconds} label="sec" textClass={style.text} />
      </View>
    </View>
  );
}
