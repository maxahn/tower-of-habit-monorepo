import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import type { TowerMember } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Text } from '~/components/ui/text';
import { useCancelAbsence, useDeclareAbsence } from '~/lib/hooks/use-absence';

const MAX_ABSENCE_DAYS = 14;
const ANNUAL_BUDGET = 28;

function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatReturnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function AbsenceControls({ towerId, member }: { towerId: string; member: TowerMember }) {
  const declare = useDeclareAbsence(towerId);
  const cancel = useCancelAbsence(towerId);
  const [days, setDays] = useState(1);

  const hasActiveAbsence = member.voluntaryReturnDate !== null;
  const daysUsed = member.voluntaryAbsenceDaysUsed;
  const daysRemaining = ANNUAL_BUDGET - daysUsed;

  if (hasActiveAbsence) {
    return (
      <Card className="border-blue-200 dark:border-blue-800">
        <CardHeader>
          <CardTitle className="text-sm">Absence active</CardTitle>
        </CardHeader>
        <CardContent>
          <Text variant="muted" className="mb-3 text-sm">
            Returns {formatReturnDate(member.voluntaryReturnDate!)}
          </Text>
          <Button
            variant="outline"
            onPress={() =>
              Alert.alert('Cancel absence?', 'You will return to active status.', [
                { text: 'Keep absence', style: 'cancel' },
                {
                  text: 'Cancel absence',
                  style: 'destructive',
                  onPress: () =>
                    cancel.mutate(undefined, {
                      onError: (err) => Alert.alert('Error', err.message),
                    }),
                },
              ])
            }
            disabled={cancel.isPending}
          >
            <Text>Cancel absence</Text>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const maxDays = Math.min(MAX_ABSENCE_DAYS, daysRemaining);
  const today = new Date();
  const from = toLocalDate(today);
  const to = toLocalDate(addDays(today, days - 1));
  const returnDate = addDays(today, days);

  const handleDeclare = () => {
    declare.mutate({ from, to }, { onError: (err) => Alert.alert('Error', err.message) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Declare absence</CardTitle>
      </CardHeader>
      <CardContent>
        <Text variant="muted" className="mb-3 text-xs">
          {daysRemaining} of {ANNUAL_BUDGET} annual days remaining
        </Text>

        {daysRemaining <= 0 ? (
          <Text className="text-sm text-red-600 dark:text-red-400">
            Annual absence budget exhausted.
          </Text>
        ) : (
          <>
            <View className="mb-3 flex-row flex-wrap gap-2">
              {Array.from({ length: maxDays }, (_, i) => i + 1).map((n) => (
                <Pressable
                  key={n}
                  onPress={() => setDays(n)}
                  className={`rounded-lg px-3 py-2 ${days === n ? 'bg-primary' : 'bg-muted'}`}
                >
                  <Text
                    className={`text-sm font-medium ${
                      days === n ? 'text-primary-foreground' : 'text-foreground'
                    }`}
                  >
                    {n}d
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text variant="muted" className="mb-3 text-sm">
              Absent {days} {days === 1 ? 'day' : 'days'} · returns{' '}
              {returnDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Text>

            <Button className="bg-primary" onPress={handleDeclare} disabled={declare.isPending}>
              <Text className="font-semibold text-primary-foreground">Confirm absence</Text>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
