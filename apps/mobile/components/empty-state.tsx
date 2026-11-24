import { View } from 'react-native';
import { Text } from '~/components/ui/text';

export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <View className="flex-1 items-center justify-center px-8 pb-16">
      <Text className="text-5xl">{icon}</Text>
      <Text variant="h4" className="mt-4 text-center">
        {title}
      </Text>
      <Text variant="muted" className="mt-2 text-center leading-5">
        {description}
      </Text>
      {children && <View className="mt-6 w-full items-center gap-3">{children}</View>}
    </View>
  );
}
