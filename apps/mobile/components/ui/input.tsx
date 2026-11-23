import { cn } from '~/lib/utils';
import { Platform, TextInput } from 'react-native';

function Input({ className, ref, ...props }: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      ref={ref}
      className={cn(
        'dark:bg-input/30 border-input bg-background text-foreground flex h-10 w-full min-w-0 flex-row items-center rounded-md border px-3 py-1 text-base leading-5 shadow-sm shadow-black/5 sm:h-9',
        props.editable === false &&
          cn(
            'opacity-50',
            Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
          ),
        Platform.select({
          native: 'placeholder:text-muted-foreground/50',
        }),
        className
      )}
      placeholderTextColor="hsl(var(--muted-foreground))"
      {...props}
    />
  );
}

export { Input };
