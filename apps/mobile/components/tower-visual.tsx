import { useEffect, useMemo } from 'react';
import { View, useColorScheme } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  FadeInUp,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import type { BaseBlockResponse } from '@tower-of-habit/shared';

const MAX_VISIBLE_BLOCKS = 20;
const COLLAPSE_DURATION = 600;
const GROW_DURATION = 400;

interface TowerVisualProps {
  height: number;
  blocks: BaseBlockResponse[];
  isCollapsing: boolean;
}

function BlockSegment({
  isCurrent,
  isNew,
  colorScheme,
}: {
  isCurrent: boolean;
  isNew: boolean;
  colorScheme: 'light' | 'dark';
}) {
  const bg = isCurrent
    ? colorScheme === 'dark'
      ? 'bg-blue-500'
      : 'bg-blue-400'
    : colorScheme === 'dark'
      ? 'bg-slate-600'
      : 'bg-slate-300';

  const borderColor = isCurrent
    ? colorScheme === 'dark'
      ? 'border-blue-400'
      : 'border-blue-500'
    : colorScheme === 'dark'
      ? 'border-slate-500'
      : 'border-slate-400';

  if (isNew) {
    return (
      <Animated.View
        entering={FadeInUp.duration(GROW_DURATION).easing(Easing.out(Easing.cubic))}
        className={`h-6 w-full rounded-sm border ${borderColor} ${bg}`}
      />
    );
  }

  return <View className={`h-6 w-full rounded-sm border ${borderColor} ${bg}`} />;
}

export function TowerVisual({ height, blocks, isCollapsing }: TowerVisualProps) {
  const colorScheme = (useColorScheme() ?? 'light') as 'light' | 'dark';
  const collapseProgress = useSharedValue(0);
  const prevHeight = useSharedValue(height);

  const baseHeight = useMemo(() => blocks.reduce((sum, b) => sum + b.blockHeight, 0), [blocks]);

  const currentRunHeight = height - baseHeight;
  const totalVisible = Math.min(height, MAX_VISIBLE_BLOCKS);

  const baseVisible = Math.min(baseHeight, Math.max(0, totalVisible - currentRunHeight));
  const currentVisible = Math.min(currentRunHeight, totalVisible);

  useEffect(() => {
    if (isCollapsing) {
      collapseProgress.value = 0;
      collapseProgress.value = withTiming(1, {
        duration: COLLAPSE_DURATION,
        easing: Easing.in(Easing.cubic),
      });
    } else {
      collapseProgress.value = 0;
    }
  }, [isCollapsing, collapseProgress]);

  const newBlocks = height > prevHeight.value ? height - prevHeight.value : 0;
  useEffect(() => {
    prevHeight.value = height;
  }, [height, prevHeight]);

  const collapseStyle = useAnimatedStyle(() => ({
    opacity: interpolate(collapseProgress.value, [0, 0.8, 1], [1, 0.3, 0]),
    transform: [
      { translateY: interpolate(collapseProgress.value, [0, 1], [0, 40]) },
      { scaleX: interpolate(collapseProgress.value, [0, 0.5, 1], [1, 1.1, 0.8]) },
    ],
  }));

  const baseRevealStyle = useAnimatedStyle(() => ({
    opacity: isCollapsing ? interpolate(collapseProgress.value, [0.5, 1], [0, 1]) : 1,
  }));

  const baseSegments: { index: number }[] = [];
  let remaining = baseVisible;
  for (const block of [...blocks].reverse()) {
    const count = Math.min(block.blockHeight, remaining);
    for (let i = 0; i < count; i++) {
      baseSegments.push({ index: baseSegments.length });
    }
    remaining -= count;
    if (remaining <= 0) break;
  }

  return (
    <View className="items-center px-4 py-2">
      <View className="w-3/5">
        {/* Current run blocks — collapse when tower falls */}
        <Animated.View style={collapseStyle} className="gap-1">
          {Array.from({ length: currentVisible }, (_, i) => (
            <BlockSegment
              key={`current-${i}`}
              isCurrent
              isNew={i < newBlocks}
              colorScheme={colorScheme}
            />
          )).reverse()}
        </Animated.View>

        {/* Base blocks — survive collapse, fade in when collapse finishes */}
        {baseSegments.length > 0 && (
          <Animated.View
            style={baseRevealStyle}
            className={`gap-1 ${currentVisible > 0 ? 'mt-1' : ''}`}
          >
            {baseSegments.map((seg) => (
              <BlockSegment
                key={`base-${seg.index}`}
                isCurrent={false}
                isNew={false}
                colorScheme={colorScheme}
              />
            ))}
          </Animated.View>
        )}

        {/* Foundation line */}
        <View className="mt-1 h-1 w-full rounded-full bg-slate-400 dark:bg-slate-600" />
      </View>
    </View>
  );
}
