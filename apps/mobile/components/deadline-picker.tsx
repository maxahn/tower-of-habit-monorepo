import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';

type Props = {
  value: string; // "HH:MM"
  onChange: (value: string) => void;
};

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function parseTime(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(':');
  return { hours: parseInt(h!, 10) || 0, minutes: parseInt(m!, 10) || 0 };
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = [0, 15, 30, 45];

export function DeadlinePicker({ value, onChange }: Props) {
  const { hours, minutes } = parseTime(value);
  const [showPicker, setShowPicker] = useState(false);

  const isOddHour = hours >= 0 && hours < 6;

  return (
    <View className="gap-2">
      <Label>Deadline time</Label>
      <Pressable
        onPress={() => setShowPicker(!showPicker)}
        className="flex-row items-center rounded-lg border border-border bg-card px-4 py-3"
      >
        <Text className="text-base text-foreground">
          {pad(hours)}:{pad(minutes)}
        </Text>
        <Text className="ml-auto text-sm text-muted-foreground">Tap to change</Text>
      </Pressable>

      {showPicker && (
        <View className="rounded-lg border border-border bg-card p-3">
          <View className="flex-row gap-4">
            <View className="flex-1 gap-1">
              <Text className="text-xs text-muted-foreground">Hour</Text>
              <View className="flex-row flex-wrap gap-1.5">
                {HOUR_OPTIONS.map((h) => (
                  <Pressable
                    key={h}
                    onPress={() => {
                      onChange(`${pad(h)}:${pad(minutes)}`);
                    }}
                    className={`w-10 items-center rounded-md py-1.5 ${
                      h === hours ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <Text
                      className={`text-sm ${h === hours ? 'font-semibold text-primary-foreground' : 'text-foreground'}`}
                    >
                      {pad(h)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>

          <View className="mt-3 gap-1">
            <Text className="text-xs text-muted-foreground">Minutes</Text>
            <View className="flex-row gap-2">
              {MINUTE_OPTIONS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => {
                    onChange(`${pad(hours)}:${pad(m)}`);
                  }}
                  className={`flex-1 items-center rounded-md py-2 ${
                    m === minutes ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <Text
                    className={`text-sm ${m === minutes ? 'font-semibold text-primary-foreground' : 'text-foreground'}`}
                  >
                    :{pad(m)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      )}

      {isOddHour && (
        <Text className="text-xs text-amber-500">
          Heads up: a deadline between midnight and 6 AM may be awkward for members in other
          timezones.
        </Text>
      )}
    </View>
  );
}
