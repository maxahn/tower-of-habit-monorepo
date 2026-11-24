import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Text } from '~/components/ui/text';
import { useColorScheme } from '~/lib/use-color-scheme';

export default function DevScreen() {
  if (!__DEV__) return <Redirect href="/habits" />;

  const { colorScheme, toggleColorScheme } = useColorScheme();
  const [inputValue, setInputValue] = useState('');

  return (
    <ScrollView className="flex-1 bg-background">
      <View className="gap-8 p-6">
        <View className="flex-row items-center justify-between">
          <Text variant="h3">Component Gallery</Text>
          <Button variant="outline" size="sm" onPress={toggleColorScheme}>
            <Text>{colorScheme === 'dark' ? 'Light' : 'Dark'}</Text>
          </Button>
        </View>

        <Separator />

        {/* Text variants */}
        <View className="gap-3">
          <Text variant="h4">Text</Text>
          <Text>Default text</Text>
          <Text variant="large">Large text</Text>
          <Text variant="small">Small text</Text>
          <Text variant="muted">Muted text</Text>
          <Text variant="lead">Lead text</Text>
          <Text variant="code">code snippet</Text>
        </View>

        <Separator />

        {/* Buttons */}
        <View className="gap-3">
          <Text variant="h4">Button</Text>
          <Button>
            <Text>Default</Text>
          </Button>
          <Button variant="secondary">
            <Text>Secondary</Text>
          </Button>
          <Button variant="destructive">
            <Text>Destructive</Text>
          </Button>
          <Button variant="outline">
            <Text>Outline</Text>
          </Button>
          <Button variant="ghost">
            <Text>Ghost</Text>
          </Button>
          <Button variant="link">
            <Text>Link</Text>
          </Button>
          <View className="flex-row gap-3">
            <Button size="sm">
              <Text>Small</Text>
            </Button>
            <Button size="lg">
              <Text>Large</Text>
            </Button>
          </View>
          <Button disabled>
            <Text>Disabled</Text>
          </Button>
        </View>

        <Separator />

        {/* Input */}
        <View className="gap-3">
          <Text variant="h4">Input</Text>
          <Label nativeID="email-label">Email</Label>
          <Input
            placeholder="hello@example.com"
            aria-labelledby="email-label"
            value={inputValue}
            onChangeText={setInputValue}
          />
          <Input placeholder="Disabled input" editable={false} />
        </View>

        <Separator />

        {/* Card */}
        <View className="gap-3">
          <Text variant="h4">Card</Text>
          <Card>
            <CardHeader>
              <CardTitle>Tower of Habit</CardTitle>
              <CardDescription>Build habits together with accountability.</CardDescription>
            </CardHeader>
            <CardContent>
              <Text>Card content goes here.</Text>
            </CardContent>
            <CardFooter>
              <Button size="sm">
                <Text>Action</Text>
              </Button>
            </CardFooter>
          </Card>
        </View>

        <Separator />

        {/* Label */}
        <View className="gap-3">
          <Text variant="h4">Label</Text>
          <Label nativeID="demo-label">Form label</Label>
          <Label nativeID="disabled-label" disabled>
            Disabled label
          </Label>
        </View>

        <View className="h-12" />
      </View>
    </ScrollView>
  );
}
