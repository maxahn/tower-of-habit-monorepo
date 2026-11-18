export type LogFields = Record<string, unknown>;

export interface Logger {
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined && { cause: value.cause }),
    };
  }
  return value;
}

export function createJsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(line + '\n')
): Logger {
  const at =
    (level: LogLevel) =>
    (fields: LogFields, msg: string): void => {
      write(
        JSON.stringify({ ...fields, level, time: new Date().toISOString(), msg }, errorReplacer)
      );
    };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}
