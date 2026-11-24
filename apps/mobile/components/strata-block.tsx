import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { BaseBlockResponse, BlockRosterMember } from '@tower-of-habit/shared';
import { Card, CardContent } from '~/components/ui/card';
import { Text } from '~/components/ui/text';

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RosterRow({ member }: { member: BlockRosterMember }) {
  const pct =
    member.total_days > 0 ? Math.round((member.qualifying_days / member.total_days) * 100) : 0;

  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text className="text-sm text-foreground">{member.display_name}</Text>
      <Text variant="muted" className="text-xs">
        {member.qualifying_days}/{member.total_days} days ({pct}%)
        {member.was_dormant ? ' · dormant' : ''}
      </Text>
    </View>
  );
}

export function StrataBlock({ block }: { block: BaseBlockResponse }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable onPress={() => setExpanded((prev) => !prev)}>
      <Card>
        <CardContent className="py-3">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="font-semibold text-foreground">Run #{block.ordinal}</Text>
              <Text variant="muted" className="text-xs">
                {formatDate(block.runStartDate)} – {formatDate(block.runEndDate)}
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-lg font-bold text-foreground">{block.blockHeight}</Text>
              <Text variant="muted" className="text-xs">
                {block.roster.length} {block.roster.length === 1 ? 'member' : 'members'}
              </Text>
            </View>
          </View>

          {expanded && (
            <View className="mt-3 border-t border-border pt-2">
              {block.roster.map((member) => (
                <RosterRow key={member.user_id} member={member} />
              ))}
            </View>
          )}
        </CardContent>
      </Card>
    </Pressable>
  );
}

export function CurrentRunCard({
  currentStreak,
  memberCount,
}: {
  currentStreak: number;
  memberCount: number;
}) {
  return (
    <Card className="border-blue-300 dark:border-blue-700">
      <CardContent className="py-3">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="font-semibold text-blue-600 dark:text-blue-400">Current run</Text>
            <Text variant="muted" className="text-xs">
              In progress
            </Text>
          </View>
          <View className="items-end">
            <Text className="text-lg font-bold text-blue-600 dark:text-blue-400">
              {currentStreak}
            </Text>
            <Text variant="muted" className="text-xs">
              {memberCount} {memberCount === 1 ? 'member' : 'members'}
            </Text>
          </View>
        </View>
      </CardContent>
    </Card>
  );
}
