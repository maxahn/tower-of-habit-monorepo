import { View } from 'react-native';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';

export type TierRow = {
  label: string;
  thresholdValue: string;
};

type Props = {
  tiers: TierRow[];
  onChange: (tiers: TierRow[]) => void;
  showThreshold: boolean;
  thresholdLabel?: string;
};

export function TierLadderEditor({ tiers, onChange, showThreshold, thresholdLabel }: Props) {
  function updateTier(index: number, field: keyof TierRow, value: string) {
    const updated = tiers.map((t, i) => (i === index ? { ...t, [field]: value } : t));
    onChange(updated);
  }

  function addTier() {
    onChange([...tiers, { label: '', thresholdValue: '' }]);
  }

  function removeTier(index: number) {
    if (tiers.length <= 1) return;
    onChange(tiers.filter((_, i) => i !== index));
  }

  return (
    <View className="gap-3">
      <Label>Tiers</Label>
      {tiers.map((tier, index) => (
        <View key={index} className="flex-row items-end gap-2 rounded-lg border border-border p-3">
          <View className="flex-1 gap-1">
            <Text className="text-xs text-muted-foreground">
              Tier {index} {index === 0 ? '(base)' : ''}
            </Text>
            <Input
              placeholder="Label"
              value={tier.label}
              onChangeText={(v) => updateTier(index, 'label', v)}
            />
          </View>
          {showThreshold && (
            <View className="w-24 gap-1">
              <Text className="text-xs text-muted-foreground">{thresholdLabel ?? 'Threshold'}</Text>
              <Input
                placeholder="0"
                value={tier.thresholdValue}
                onChangeText={(v) => updateTier(index, 'thresholdValue', v)}
                keyboardType="numeric"
              />
            </View>
          )}
          {tiers.length > 1 && (
            <Button variant="ghost" className="mb-0.5" onPress={() => removeTier(index)}>
              <Text className="text-destructive">✕</Text>
            </Button>
          )}
        </View>
      ))}
      <Button variant="outline" onPress={addTier}>
        <Text>Add Tier</Text>
      </Button>
    </View>
  );
}
