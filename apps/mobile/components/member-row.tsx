import { View } from 'react-native';
import type { TowerMember, PeriodMemberPreview } from '@tower-of-habit/shared';
import { Text } from '~/components/ui/text';

const STATE_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  active: { label: 'Active', bg: 'bg-green-100', text: 'text-green-800' },
  at_risk: { label: 'At risk', bg: 'bg-amber-100', text: 'text-amber-800' },
  dormant: { label: 'Dormant', bg: 'bg-zinc-100', text: 'text-zinc-500' },
};

const DORMANCY_LABELS: Record<string, string> = {
  consecutive_miss: 'Missed periods',
  backstop: 'Backstop',
  voluntary: 'Voluntary absence',
};

function StateBadge({ state }: { state: string }) {
  const style = STATE_STYLES[state] ?? STATE_STYLES.active!;
  return (
    <View className={`rounded-full px-2 py-0.5 ${style.bg}`}>
      <Text className={`text-xs font-medium ${style.text}`}>{style.label}</Text>
    </View>
  );
}

function StandingIndicator({ standing }: { standing: string }) {
  if (standing === 'met') {
    return (
      <View className="h-6 w-6 items-center justify-center rounded-full bg-green-500">
        <Text className="text-xs font-bold text-white">✓</Text>
      </View>
    );
  }
  if (standing === 'short') {
    return (
      <View className="h-6 w-6 items-center justify-center rounded-full bg-red-100">
        <Text className="text-xs font-bold text-red-600">✗</Text>
      </View>
    );
  }
  if (standing === 'excused') {
    return (
      <View className="h-6 w-6 items-center justify-center rounded-full bg-blue-100">
        <Text className="text-xs text-blue-600">—</Text>
      </View>
    );
  }
  return null;
}

function formatReturnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function MemberRow({
  member,
  preview,
  isHost,
  isSelf,
}: {
  member: TowerMember;
  preview?: PeriodMemberPreview;
  isHost: boolean;
  isSelf: boolean;
}) {
  const isDormant = member.state === 'dormant';

  return (
    <View
      className={`flex-row items-center justify-between border-b border-border py-3 ${isDormant ? 'opacity-50' : ''}`}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-medium text-foreground">
            {member.displayName ?? 'Anonymous'}
          </Text>
          {isHost && (
            <View className="rounded-full bg-primary/15 px-2 py-0.5">
              <Text className="text-xs font-medium text-primary">Host</Text>
            </View>
          )}
          {isSelf && (
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text className="text-xs text-muted-foreground">You</Text>
            </View>
          )}
        </View>
        <View className="mt-1 flex-row items-center gap-2">
          <Text className="text-sm text-muted-foreground">{member.habitName}</Text>
          <StateBadge state={member.state} />
        </View>
        {isDormant && member.dormancyReason && (
          <Text className="mt-0.5 text-xs text-zinc-500">
            {DORMANCY_LABELS[member.dormancyReason] ?? member.dormancyReason}
          </Text>
        )}
        {member.voluntaryReturnDate && (
          <Text className="mt-0.5 text-xs text-blue-600 dark:text-blue-400">
            Returns {formatReturnDate(member.voluntaryReturnDate)}
          </Text>
        )}
      </View>
      {preview && <StandingIndicator standing={preview.standing} />}
    </View>
  );
}
