export interface InflightRegistry {
  begin(
    id: string | number,
    controller?: AbortController,
  ): {
    controller: AbortController;
    previous: AbortController | undefined;
  };
  cancel(id: string | number): boolean;
  settle(id: string | number, controller: AbortController): boolean;
  readonly size: number;
}

export declare function createInflight(): InflightRegistry;
