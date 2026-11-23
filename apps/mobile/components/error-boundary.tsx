import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (__DEV__) {
      console.error('ErrorBoundary caught:', error, info.componentStack);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <View className="flex-1 items-center justify-center bg-background px-6">
          <Text variant="h3" className="mb-2">
            Something went wrong
          </Text>
          <Text variant="muted" className="mb-6 text-center">
            The app ran into an unexpected error. Please try again.
          </Text>
          {__DEV__ && (
            <Text variant="code" className="mb-6 text-destructive">
              {this.state.error.message}
            </Text>
          )}
          <Button onPress={() => this.setState({ error: null })}>
            <Text>Try Again</Text>
          </Button>
        </View>
      );
    }
    return this.props.children;
  }
}
