import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Pressable, Share, View } from 'react-native';
import type { TowerLobbyResponse, TowerMember } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useAuth } from '~/lib/auth-context';
import { useLeaveTower, useRemoveMember, useStartTower } from '~/lib/hooks/use-towers';

function formatJoinCode(code: string): string {
  if (code.length === 8) return `${code.slice(0, 4)}-${code.slice(4)}`;
  return code;
}

function habitTypeBadgeLabel(type: string): string {
  if (type === 'binary') return 'B';
  if (type === 'numeric') return 'N';
  return 'T';
}

function MemberRow({
  member,
  isHost,
  isSelf,
  viewerIsHost,
  onRemove,
}: {
  member: TowerMember;
  isHost: boolean;
  isSelf: boolean;
  viewerIsHost: boolean;
  onRemove: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between border-b border-border py-3">
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
          {isSelf && !isHost && (
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text className="text-xs text-muted-foreground">You</Text>
            </View>
          )}
        </View>
        <View className="mt-1 flex-row items-center gap-2">
          <View className="h-5 w-5 items-center justify-center rounded bg-muted">
            <Text className="text-xs font-medium text-muted-foreground">
              {habitTypeBadgeLabel(member.habitType)}
            </Text>
          </View>
          <Text className="text-sm text-muted-foreground">{member.habitName}</Text>
        </View>
      </View>
      {viewerIsHost && !isSelf && (
        <Pressable
          onPress={() => {
            Alert.alert('Remove Member', `Remove ${member.displayName ?? 'this member'}?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: onRemove },
            ]);
          }}
          className="ml-2 rounded-md bg-destructive/10 px-3 py-1.5"
        >
          <Text className="text-xs font-medium text-destructive">Remove</Text>
        </Pressable>
      )}
    </View>
  );
}

export function Lobby({ data, onLeave }: { data: TowerLobbyResponse; onLeave?: () => void }) {
  const { state } = useAuth();
  const userId = state.status === 'authenticated' ? state.user.id : '';
  const { tower, members, role, joinCode } = data;

  const removeMember = useRemoveMember(tower.id);
  const leaveTower = useLeaveTower(tower.id);
  const startTower = useStartTower(tower.id);

  const [copied, setCopied] = useState(false);

  const isHost = role === 'host';
  const canStart = isHost && members.length >= 2;
  const formatted = formatJoinCode(joinCode);

  const myMembership = members.find((m) => m.userId === userId);

  async function handleCopy() {
    await Clipboard.setStringAsync(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    await Share.share({
      message: `Join my tower "${tower.name}" with code: ${formatted}`,
    });
  }

  function handleLeave() {
    if (!myMembership) return;
    Alert.alert('Leave Tower', `Leave "${tower.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => leaveTower.mutate(myMembership.membershipId, { onSuccess: onLeave }),
      },
    ]);
  }

  return (
    <View className="flex-1 bg-background px-4 pt-4">
      {/* Tower info */}
      <Text variant="h3">{tower.name}</Text>
      <Text variant="muted" className="mt-1">
        {tower.periodUnit} · quota {tower.quota} · deadline {tower.deadlineTime}
      </Text>

      {/* Join code */}
      <View className="mt-6 items-center rounded-xl border border-border bg-card p-5">
        <Text className="text-sm text-muted-foreground">Join Code</Text>
        <Text className="mt-1 text-3xl font-bold tracking-widest text-foreground">{formatted}</Text>
        <View className="mt-4 flex-row gap-3">
          <Button variant="outline" size="sm" onPress={handleCopy}>
            <Text>{copied ? 'Copied!' : 'Copy'}</Text>
          </Button>
          <Button variant="outline" size="sm" onPress={handleShare}>
            <Text>Share</Text>
          </Button>
        </View>
      </View>

      {/* Members */}
      <View className="mt-6">
        <Text className="text-sm font-medium text-muted-foreground">
          Members ({members.length})
        </Text>
        <View className="mt-2">
          {members.map((member) => {
            const memberIsHost = member.userId === tower.hostId;
            const memberIsSelf = member.userId === userId;
            return (
              <MemberRow
                key={member.membershipId}
                member={member}
                isHost={memberIsHost}
                isSelf={memberIsSelf}
                viewerIsHost={isHost}
                onRemove={() => removeMember.mutate(member.membershipId)}
              />
            );
          })}
        </View>
      </View>

      {/* Actions */}
      <View className="mt-8">
        {isHost ? (
          <Button onPress={() => startTower.mutate()} disabled={!canStart || startTower.isPending}>
            <Text>
              {startTower.isPending
                ? 'Starting...'
                : canStart
                  ? 'Start Tower'
                  : `Need ${2 - members.length} more member${2 - members.length !== 1 ? 's' : ''}`}
            </Text>
          </Button>
        ) : (
          <Button variant="destructive" onPress={handleLeave} disabled={leaveTower.isPending}>
            <Text>{leaveTower.isPending ? 'Leaving...' : 'Leave Tower'}</Text>
          </Button>
        )}
      </View>
    </View>
  );
}
