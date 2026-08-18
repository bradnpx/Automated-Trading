declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(
    path: string,
    data: string,
    encoding: "utf8",
  ): Promise<void>;
  export function mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:assert/strict" {
  interface Assert {
    equal<T>(actual: T, expected: T, message?: string): void;
  }

  const assert: Assert;
  export default assert;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  exitCode: number | undefined;
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
};
