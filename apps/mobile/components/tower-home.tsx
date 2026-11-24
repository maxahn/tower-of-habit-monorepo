import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import type { TowerActiveResponse, PeriodPreviewResponse } from '@tower-of-habit/shared';
import { Countdown } from '~/components/countdown';
import { MemberRow } from '~/components/member-row';
import { TowerVisualBoundary } from '~/components/tower-visual-boundary';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Text } from '~/components/ui/text';
import { useAuth } from '~/lib/auth-context';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  open: { label: 'Open', bg: 'bg-green-100', text: 'text-green-800' },
  wobbling: { label: 'Wobbling', bg: 'bg-amber-100', text: 'text-amber-800' },
  survived: { label: 'Survived', bg: 'bg-green-100', text: 'text-green-800' },
  collapsed: { label: 'Collapsed', bg: 'bg-red-100', text: 'text-red-800' },
};

function PeriodStatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.open!;
  return (
    <View className={`self-start rounded-full px-3 py-1 ${style.bg}`}>
      <Text className={`text-xs font-semibold ${style.text}`}>{style.label}</Text>
    </View>
  );
}

function totalHeight(data: TowerActiveResponse): number {
  const blockTotal = data.blocks.reduce((sum, b) => sum + b.blockHeight, 0);
  return blockTotal + data.tower.currentStreak;
}

export function TowerHome({
  data,
  preview,
}: {
  data: TowerActiveResponse;
  preview?: PeriodPreviewResponse;
}) {
  const { state } = useAuth();
  const userId =
    state.status === 'authenticated' || state.status === 'onboarding' ? state.user.id : null;

  const myMember = data.members.find((m) => m.userId === userId);

  const isCollapsing = preview?.periodStatus === 'collapsed';

  return (
    <View className="gap-4">
      {/* Tower visual */}
      <TowerVisualBoundary
        height={totalHeight(data)}
        blocks={data.blocks}
        isCollapsing={isCollapsing}
      />

      {/* Header */}
      <View>
        <Text variant="h3">{data.tower.name}</Text>
        <View className="mt-2 flex-row gap-4">
          <View>
            <Text className="text-2xl font-bold text-foreground">{data.tower.currentStreak}</Text>
            <Text variant="muted">Streak</Text>
          </View>
          <View>
            <Text className="text-2xl font-bold text-foreground">{totalHeight(data)}</Text>
            <Text variant="muted">Total height</Text>
          </View>
          <View>
            <Text className="text-2xl font-bold text-foreground">{data.blocks.length}</Text>
            <Text variant="muted">Blocks</Text>
          </View>
        </View>
      </View>

      {/* Log shortcut */}
      {myMember && (myMember.state === 'active' || myMember.state === 'at_risk') && (
        <Button
          onPress={() => router.push(`/(tabs)/index/${myMember.habitId}`)}
          className="bg-primary"
        >
          <Text className="font-semibold text-primary-foreground">Log {myMember.habitName}</Text>
        </Button>
      )}

      {/* Current period */}
      {data.currentPeriod && (
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between">
              <CardTitle>Current period</CardTitle>
              {preview && <PeriodStatusBadge status={preview.periodStatus} />}
            </View>
          </CardHeader>
          <CardContent>
            <View className="gap-1">
              <Text className="text-sm text-foreground">
                {formatDate(data.currentPeriod.periodStart)}
                {data.currentPeriod.periodStart !== data.currentPeriod.periodEnd &&
                  ` – ${formatDate(data.currentPeriod.periodEnd)}`}
              </Text>
              <Text variant="muted">Deadline: {formatDeadline(data.currentPeriod.deadlineAt)}</Text>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Countdown */}
      {data.currentPeriod && <Countdown deadlineAt={data.currentPeriod.deadlineAt} />}

      {/* Wobble warning */}
      {preview?.periodStatus === 'wobbling' && preview.outstanding.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent>
            <Text className="font-semibold text-amber-800">
              Waiting on {preview.outstanding.length}{' '}
              {preview.outstanding.length === 1 ? 'member' : 'members'}
            </Text>
            <Text className="mt-1 text-sm text-amber-700">
              {data.members
                .filter((m) => preview.outstanding.includes(m.membershipId))
                .map((m) => m.displayName ?? 'Anonymous')
                .join(', ')}
            </Text>
          </CardContent>
        </Card>
      )}

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>Members ({data.members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.members.map((member) => (
            <MemberRow
              key={member.membershipId}
              member={member}
              preview={preview?.members.find((p) => p.membershipId === member.membershipId)}
              isHost={member.userId === data.tower.hostId}
              isSelf={member.userId === userId}
            />
          ))}
        </CardContent>
      </Card>

      {/* Strata history link */}
      <Pressable
        className="items-center py-2"
        onPress={() => router.push(`/(tabs)/towers/${data.tower.id}/history`)}
      >
        <Text className="text-sm font-medium text-primary">
          {data.blocks.length > 0 ? `View base blocks (${data.blocks.length})` : 'View run history'}
        </Text>
      </Pressable>
    </View>
  );
}
